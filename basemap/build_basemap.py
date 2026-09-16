"""Build a minimal vector basemap for Shanghai from OpenStreetMap.

    python basemap/build_basemap.py

Emits one `data/basemap.<region>.json` per region -- water, green space and a
three-tier road network for the box around that region's pins -- plus a small
`data/basemap.index.json` describing them. This exists so the map can stop
borrowing CARTO's raster tiles, which are free to *use* but not free to bundle
into a paid download. OSM data is ODbL: free commercially, with attribution.
See `web/basemap-lab.html` to judge how it looks.

Regions are separate files rather than one wide box because the day trips are
far away and mostly empty in between: a single box spanning Shanghai, Suzhou
and Hangzhou would be roughly twelve times the area for six more restaurants.
The web layer loads a region the first time you ask for it and keeps it.

Output is deliberately not GeoJSON. A FeatureCollection wrapper costs ~60 bytes
per feature in `{"type":"Feature","properties":{},...}` boilerplate, and at
17k features that is a megabyte of nothing. Instead each layer is a flat list
of coordinate rings; the renderer treats a ring whose first point equals its
last as a polygon and everything else as a line.

Fetching is cached in `basemap/cache/`, so re-running to change simplification
or thresholds costs no network. Delete that folder to refresh from OSM.
"""
import gzip
import hashlib
import io
import json
import math
import os
import sys
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CACHE = os.path.join(HERE, "cache")
DATA = os.path.join(ROOT, "data")

# Each box is padded well past its pins so the map does not end in mid-air when
# someone pans past the outermost restaurant. Shanghai's 47 span
# lat 31.1394..31.3575, lng 121.3119..121.4955; Suzhou's three sit within 500m
# of each other; Hangzhou's three spread about 8km.
REGIONS = {
    "shanghai": {"label": "Shanghai", "bbox": (31.10, 121.27, 31.40, 121.54),
                 "min_zoom": 11},
    "suzhou":   {"label": "Suzhou",   "bbox": (31.27, 120.58, 31.35, 120.66),
                 "min_zoom": 11},
    "hangzhou": {"label": "Hangzhou", "bbox": (30.21, 120.06, 30.34, 120.19),
                 "min_zoom": 11},
    # The day-trips view refits to zoom 9 across all three cities, where the
    # detailed boxes are three islands with nothing between them. This covers
    # the whole span with water and the big roads only, simplified hard --
    # at zoom 9-11 that is everything the eye can resolve anyway, and without
    # it the wide view reads as broken rather than sparse. Its zoom window
    # does not overlap the detailed boxes: drawing both at once cost more
    # than a frame, and a clean handover is what a tile pyramid does anyway.
    # Sized for what the eye can actually resolve at zoom 9, where one pixel is
    # about 260m: motorways and trunk roads only (primary is noise at that
    # scale), ~165m simplification, and only water bodies over 2.5km across --
    # the Yangtze delta is full of ponds that cost bytes and draw as nothing.
    "overview": {"label": "Overview", "bbox": (30.10, 119.95, 31.50, 121.70),
                 "layers": ["water", "roads_major"],
                 "major": "^(motorway|trunk)$",
                 "water_lines": False,
                 "tolerance": 0.0015,        # ~165m, under a pixel at zoom 9
                 "min_poly_span_m": 2500.0,
                 "max_zoom": 10},
}

# overpass.osm.ch answers in 0.2s with an empty database -- do not add it back.
# kumi and private.coffee hold real data but run ~160s and lag by months.
MIRRORS = [
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]

def layers_for(bbox, major="^(motorway|trunk|primary)$", water_lines=True):
    box = "{},{},{},{}".format(*bbox)
    # Line waterways are the canal network. Essential in the city, pure noise
    # over a 167km box where a canal is a third of a pixel wide.
    lines = f"""
            way["waterway"="river"]({box});
            way["waterway"="canal"]({box});
    """ if water_lines else ""
    # Relations matter more than they look. A river or a large park is usually a
    # multipolygon in OSM, with the tag on the relation and its outline split
    # across member ways that carry no tag of their own -- so a ways-only query
    # misses the feature entirely. Measured before this was added: 24% of the
    # Huangpu's centreline through the city had no water surface beneath it, and
    # the river rendered as a smudge with holes in it.
    return {
        "water": f"""
            way["natural"="water"]({box});
            way["waterway"="riverbank"]({box});
            relation["natural"="water"]({box});
            relation["waterway"="riverbank"]({box});
            {lines}
        """,
        "green": f"""
            way["leisure"="park"]({box});
            way["landuse"~"^(forest|grass|cemetery)$"]({box});
            relation["leisure"="park"]({box});
            relation["landuse"~"^(forest|grass|cemetery)$"]({box});
        """,
        "roads_major": f'way["highway"~"{major}"]({box});',
        "roads_secondary": f'way["highway"="secondary"]({box});',
        "roads_tertiary": f'way["highway"="tertiary"]({box});',
    }


LAYER_ORDER = ["water", "green", "roads_major", "roads_secondary", "roads_tertiary"]

# ~3m at this latitude: about one pixel at zoom 16, the deepest zoom that gets
# its own geometry. Anything coarser visibly straightens curved roads up close.
TOLERANCE = 0.000025
DECIMALS = 5

# Skip specks. A 20m grass triangle costs bytes at every zoom and is invisible
# at all of them. Lines are exempt -- a short road link still connects things.
MIN_POLY_SPAN_M = 30.0


def fetch(region, name, body):
    os.makedirs(CACHE, exist_ok=True)
    # The query is part of the cache key. Without it, editing a query and
    # re-running silently returns the previous answer -- which is exactly the
    # trap that hid the missing relations, since the filename alone had not
    # changed. A stale hit is worse than a slow miss.
    digest = hashlib.sha1(body.encode("utf-8")).hexdigest()[:8]
    path = os.path.join(CACHE, f"{region}_{name}.{digest}.json")
    if os.path.exists(path):
        with io.open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        print(f"  {name}: {len(data.get('elements', []))} elements (cached)")
        return data

    query = f"[out:json][timeout:180];({body});out geom;"
    last = None
    for host in MIRRORS:
        for attempt in range(3):
            try:
                started = time.time()
                request = urllib.request.Request(
                    host, data=query.encode("utf-8"),
                    headers={"User-Agent": "shanghai-food-map/1.0"})
                raw = urllib.request.urlopen(request, timeout=300).read()
                data = json.loads(raw)
                count = len(data.get("elements", []))
                # An empty answer means a broken mirror, not an empty Shanghai.
                if count == 0:
                    raise ValueError("empty result set")
                print(f"  {name}: {count} ways "
                      f"({time.time() - started:.1f}s) via {host.split('/')[2]}")
                with io.open(path, "w", encoding="utf-8") as fh:
                    fh.write(json.dumps(data))
                return data
            except Exception as exc:                  # noqa: BLE001
                last = exc
                print(f"  {name}: {host.split('/')[2]} attempt {attempt + 1} "
                      f"failed ({type(exc).__name__})")
                time.sleep(5 + attempt * 10)
    raise SystemExit(f"all mirrors failed for {name}: {last}")


def perpendicular(point, start, end):
    (x, y), (x1, y1), (x2, y2) = point, start, end
    dx, dy = x2 - x1, y2 - y1
    if dx == 0 and dy == 0:
        return math.hypot(x - x1, y - y1)
    t = max(0.0, min(1.0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy)))
    return math.hypot(x - (x1 + t * dx), y - (y1 + t * dy))


def simplify(points, tolerance):
    """Douglas-Peucker, iterative -- a recursive one blows the stack on rivers."""
    if len(points) < 3:
        return points
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        if j <= i + 1:
            continue
        worst, index = -1.0, i
        for k in range(i + 1, j):
            d = perpendicular(points[k], points[i], points[j])
            if d > worst:
                worst, index = d, k
        if worst > tolerance:
            keep[index] = True
            stack.append((i, index))
            stack.append((index, j))
    return [p for p, k in zip(points, keep) if k]


def stitch(segments):
    """Walk a multipolygon's member ways into closed rings.

    Overpass hands back the members in no particular order and no particular
    direction, so an outline only exists once they are joined end to end.
    Endpoints are compared exactly, deliberately: members of a relation share
    OSM node ids, so a real join is identical to the last decimal, and a
    tolerance here would fuse two river banks that genuinely never meet.
    """
    pending = [list(s) for s in segments if len(s) >= 2]
    rings = []
    while pending:
        ring = pending.pop()
        joined = True
        while joined and ring[0] != ring[-1]:
            joined = False
            for i, seg in enumerate(pending):
                if seg[0] == ring[-1]:
                    ring.extend(seg[1:])
                elif seg[-1] == ring[-1]:
                    ring.extend(reversed(seg[:-1]))
                elif seg[-1] == ring[0]:
                    ring = seg[:-1] + ring
                elif seg[0] == ring[0]:
                    ring = list(reversed(seg[1:])) + ring
                else:
                    continue
                pending.pop(i)
                joined = True
                break
        rings.append(ring)
    return rings


def geometries(data):
    """Each element as one coordinate list, relations stitched into rings.

    Only `outer` members are kept. The renderer fills every ring on its own, so
    an inner ring would paint a puddle of water inside its own lake rather than
    cutting an island out of it. Islands are small enough at these zooms to be
    worth less than that bug -- West Lake's are the only ones in range.
    """
    out, unclosed = [], 0
    for element in data.get("elements", []):
        if element.get("type") != "relation":
            geometry = element.get("geometry") or []
            out.append([(g["lon"], g["lat"]) for g in geometry if g])
            continue

        segments = [[(g["lon"], g["lat"]) for g in member["geometry"] if g]
                    for member in element.get("members", [])
                    if member.get("role") in ("outer", "") and member.get("geometry")]
        for ring in stitch(segments):
            # An outline that will not close is broken data, or a relation
            # reaching past what Overpass returned. Half a lake drawn as a
            # filled sliver looks far worse than no lake at all.
            if len(ring) > 3 and ring[0] == ring[-1]:
                out.append(ring)
            else:
                unclosed += 1
    if unclosed:
        print(f"    ({unclosed} relation outlines would not close, skipped)")
    return out


def build_layer(data, tolerance=None, min_span=None):
    tolerance = TOLERANCE if tolerance is None else tolerance
    min_span = MIN_POLY_SPAN_M if min_span is None else min_span
    rings, dropped, points_in, points_out = [], 0, 0, 0
    for raw in geometries(data):
        if len(raw) < 2:
            continue
        points_in += len(raw)
        closed = raw[0] == raw[-1] and len(raw) > 3

        if closed:
            lons = [p[0] for p in raw]
            lats = [p[1] for p in raw]
            width = (max(lons) - min(lons)) * 111320 * math.cos(math.radians(lats[0]))
            height = (max(lats) - min(lats)) * 111320
            if math.hypot(width, height) < min_span:
                dropped += 1
                continue

        thinned = simplify(raw, tolerance)
        if closed and len(thinned) < 4:
            dropped += 1
            continue
        if closed and thinned[0] != thinned[-1]:
            thinned.append(thinned[0])

        points_out += len(thinned)
        rings.append([[round(x, DECIMALS), round(y, DECIMALS)] for x, y in thinned])
    return rings, dropped, points_in, points_out


def delta_bytes(rings):
    """What integer delta-encoding would cost, to size up the remaining headroom."""
    scale = 10 ** DECIMALS
    out = []
    for ring in rings:
        px = py = 0
        encoded = []
        for x, y in ring:
            ix, iy = int(round(x * scale)), int(round(y * scale))
            encoded.append(ix - px)
            encoded.append(iy - py)
            px, py = ix, iy
        out.append(encoded)
    return len(json.dumps(out, separators=(",", ":")).encode("utf-8"))


def build_region(key, spec):
    south, west, north, east = spec["bbox"]
    width = (east - west) * 111.32 * math.cos(math.radians((north + south) / 2))
    height = (north - south) * 111.32
    print(f"\n{spec['label']}  ({width:.0f} x {height:.0f} km)")

    tolerance = spec.get("tolerance", TOLERANCE)
    min_span = spec.get("min_poly_span_m", MIN_POLY_SPAN_M)
    wanted = spec.get("layers", LAYER_ORDER)

    payload = {
        "meta": {
            "region": key,
            "label": spec["label"],
            "bbox": [south, west, north, east],
            "source": "OpenStreetMap contributors, ODbL",
            "tolerance_deg": tolerance,
            "decimals": DECIMALS,
            "note": "closed ring (first point == last) is a polygon, else a line",
        },
        "layers": {},
    }

    queries = layers_for(spec["bbox"],
                         spec.get("major", "^(motorway|trunk|primary)$"),
                         spec.get("water_lines", True))
    rows, plain_total, delta_total = [], 0, 0
    for name in wanted:
        rings, dropped, points_in, points_out = build_layer(
            fetch(key, name, queries[name]), tolerance, min_span)
        payload["layers"][name] = rings

        plain = len(json.dumps(rings, separators=(",", ":")).encode("utf-8"))
        plain_total += plain
        delta_total += delta_bytes(rings)
        rows.append((name, len(rings), dropped, points_in, points_out, plain))

    out = os.path.join(DATA, f"basemap.{key}.json")
    with io.open(out, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, separators=(",", ":"))

    on_disk = os.path.getsize(out)
    with io.open(out, "rb") as fh:
        gzipped = len(gzip.compress(fh.read(), 9))

    print(f"\n  {'layer':<18}{'rings':>8}{'dropped':>9}"
          f"{'points in':>11}{'out':>9}{'KB':>8}")
    print("  " + "-" * 63)
    for name, rings, dropped, points_in, points_out, plain in rows:
        print(f"  {name:<18}{rings:>8,}{dropped:>9,}"
              f"{points_in:>11,}{points_out:>9,}{plain / 1024:>8.0f}")
    print(f"  -> {os.path.relpath(out, ROOT)}   "
          f"{on_disk / 1024:,.0f} KB on disk, {gzipped / 1024:,.0f} KB gzipped")

    entry = {
        "region": key,
        "label": spec["label"],
        "bbox": [south, west, north, east],
        "file": f"basemap.{key}.json",
        "kb": round(on_disk / 1024),
        "kb_gzip": round(gzipped / 1024),
        "rings": sum(r[1] for r in rows),
        "delta_kb": round(delta_total / 1024),
        "layers": wanted,
    }
    # zoom window, so the renderer knows the coarse overview belongs to the
    # wide view and the detailed boxes to everything closer in
    if "min_zoom" in spec:
        entry["min_zoom"] = spec["min_zoom"]
    if "max_zoom" in spec:
        entry["max_zoom"] = spec["max_zoom"]
    return entry


def main(only=None):
    """Build every region, or just the ones named on the command line.

    The subset matters because `overview` is built but not shipped, and its box
    is 167km across -- refetching it costs far more than the three city boxes
    put together, for a file the map no longer loads.
    """
    unknown = [k for k in (only or []) if k not in REGIONS]
    if unknown:
        raise SystemExit(f"unknown region(s): {', '.join(unknown)}")
    built = {key: build_region(key, REGIONS[key])
             for key in REGIONS if not only or key in only}

    index_path = os.path.join(DATA, "basemap.index.json")

    # Merged rather than replaced: rebuilding a subset must not quietly delete
    # the index entries for the regions that were not rebuilt.
    previous = []
    if os.path.exists(index_path):
        with io.open(index_path, encoding="utf-8") as fh:
            previous = json.load(fh).get("regions", [])
    index = []
    for key in REGIONS:
        if key in built:
            index.append(built[key])
            continue
        carried = next((r for r in previous if r.get("region") == key), None)
        if carried:
            print(f"  index: carried {key} forward unchanged (not rebuilt)")
            index.append(carried)

    with io.open(index_path, "w", encoding="utf-8") as fh:
        json.dump({
            "source": "OpenStreetMap contributors, ODbL",
            "regions": index,
        }, fh, indent=1)

    total_disk = sum(r["kb"] for r in index)
    total_gzip = sum(r["kb_gzip"] for r in index)
    total_delta = sum(r["delta_kb"] for r in index)

    print(f"\n{'region':<12}{'rings':>9}{'KB':>9}{'KB gzip':>10}")
    print("-" * 40)
    for r in index:
        print(f"{r['label']:<12}{r['rings']:>9,}{r['kb']:>9,}{r['kb_gzip']:>10,}")
    print("-" * 40)
    print(f"{'all three':<12}{sum(r['rings'] for r in index):>9,}"
          f"{total_disk:>9,}{total_gzip:>10,}")
    print(f"\nwrote {os.path.relpath(index_path, ROOT)}")
    print(f"  only Shanghai loads up front; the day trips load when asked for")
    print(f"  delta-encoding would take the on-disk total to ~{total_delta:,} KB "
          f"({100 - total_delta * 100 / max(total_disk, 1):.0f}% smaller) if needed")


if __name__ == "__main__":
    main(sys.argv[1:] or None)
