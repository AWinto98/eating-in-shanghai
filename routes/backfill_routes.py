"""Fetch every walking route the map could ever need, once, and ship the answers.

    python routes/backfill_routes.py --dry-run     # count the work, spend nothing
    python routes/backfill_routes.py               # do it
    python routes/backfill_routes.py --limit 50    # a taste, to check the wiring

Today a walk is planned live: `walk.js` asks `/api/walking`, `serve.py` asks
Amap using the key in `.env`. That cannot ship -- we would be handing every
buyer the key, or paying for their routes forever. So we ask Amap once, here,
for every pair of restaurants that could plausibly be walked between, and write
the answers to `data/routes.json`. After that the map needs no key, no proxy and
no network to plan a walk.

Routes come from `serve.walking()` rather than a reimplementation, so what gets
baked in is byte-for-byte what the live proxy returns today -- same candidate
choice, same GCJ-02 to WGS-84 conversion, same normalisation. If that function
ever changes, this file follows it for free.

Pairs are directed and within-city. Directed because Amap keys A->B and B->A
separately and a one-way lane makes them genuinely different; within-city
because nobody walks from Shanghai to Hangzhou, and asking costs quota to store
a five-hour answer nobody wants.

Resumable: every response lands in `data/route_cache.json`, so a run stopped by
quota, a dropped connection or Ctrl-C picks up where it left off at no cost.
"""
import argparse
import gzip
import io
import json
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))                 # serve.py
sys.path.insert(0, str(ROOT / "geocode"))     # geocode.py, via serve
sys.path.insert(0, str(ROOT / "basemap"))     # simplify

import geocode as G          # noqa: E402  (needs the paths above)
import serve as S            # noqa: E402
from build_basemap import simplify  # noqa: E402

GEO_PATH = ROOT / "data" / "restaurants.geo.json"
CACHE_PATH = ROOT / "data" / "route_cache.json"
OUT_PATH = ROOT / "data" / "routes.json"

# ~2m, about a pixel at the deepest zoom anyone walks at. Amap returns a point
# every few metres along a pavement; most of them say nothing a walker needs.
TOLERANCE = 0.00002
DECIMALS = 5

SAVE_EVERY = 100     # cache writes are a full rewrite, so batch them


def gcj(record):
    """Exactly the string walk.js sends, so the existing cache entries hit."""
    point = record["geo"]["gcj02"]
    return f"{point['lng']},{point['lat']}"


def load_records():
    with io.open(GEO_PATH, encoding="utf-8") as fh:
        payload = json.load(fh)
    return [r for r in payload["restaurants"] if r.get("geo", {}).get("gcj02")]


def build_pairs(records):
    """Directed pairs, grouped by city. Returns [(from, to), ...]."""
    by_city = {}
    for record in records:
        by_city.setdefault(record.get("city") or "?", []).append(record)

    pairs = []
    for city in sorted(by_city):
        group = by_city[city]
        for origin in group:
            for destination in group:
                if origin["id"] != destination["id"]:
                    pairs.append((origin, destination))
    return pairs, by_city


def compress_path(path):
    """Thin the polyline and drop a decimal place. Halves it, invisibly."""
    thinned = simplify([tuple(p) for p in path], TOLERANCE) if len(path) > 2 else path
    out = []
    for lat, lng in thinned:
        point = [round(lat, DECIMALS), round(lng, DECIMALS)]
        if not out or out[-1] != point:
            out.append(point)
    return out


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="report what would be fetched, spend no quota")
    parser.add_argument("--limit", type=int, default=0,
                        help="stop after this many new fetches")
    parser.add_argument("--qps", type=float, default=G.DEFAULT_QPS)
    args = parser.parse_args()

    records = load_records()
    pairs, by_city = build_pairs(records)

    print(f"{len(records)} restaurants")
    for city in sorted(by_city):
        n = len(by_city[city])
        print(f"  {city:<10} {n:>3} -> {n * (n - 1):>5} directed pairs")
    print(f"{len(pairs)} pairs total")

    amap = G.Amap(G.load_key(), CACHE_PATH, qps=args.qps)
    S.amap = amap

    cached = sum(1 for a, b in pairs if f"walk|{gcj(a)}|{gcj(b)}" in amap.cache)
    todo = len(pairs) - cached
    # --qps is a ceiling, not a speed: each call still pays Amap's round trip,
    # which measured ~1.8s from here. Observed throughput is what to trust, so
    # the progress lines below re-estimate from the actual rate.
    print(f"  {cached} already cached, {todo} to fetch")
    print(f"  floor {todo / max(args.qps, 0.01) / 60:.0f} min at {args.qps} qps; "
          f"expect nearer {todo * 1.8 / 60:.0f} min at the latency seen so far\n")

    if args.dry_run:
        print("dry run, stopping here")
        return

    # serve.walking() saves the cache on every call, which is a full rewrite of
    # a file that ends up tens of MB. Fine for one request from a browser, not
    # for thousands in a row -- so batch it and restore on the way out.
    real_save = amap.save
    amap.save = lambda: None

    ok = failed = fetched = 0
    failures = []
    started = time.time()

    try:
        for i, (origin, destination) in enumerate(pairs, 1):
            key = f"walk|{gcj(origin)}|{gcj(destination)}"
            was_cached = key in amap.cache

            try:
                route, error = S.walking(gcj(origin), gcj(destination))
            except Exception as exc:                       # noqa: BLE001
                route, error = None, f"{type(exc).__name__}: {exc}"

            if route is None:
                failed += 1
                failures.append({"from": origin["id"], "to": destination["id"],
                                 "error": error})
            else:
                ok += 1

            if not was_cached:
                fetched += 1
                if fetched % SAVE_EVERY == 0:
                    real_save()
                    rate = fetched / max(time.time() - started, 0.01)
                    left = (todo - fetched) / max(rate, 0.01) / 60
                    print(f"  {i}/{len(pairs)}  fetched {fetched}  "
                          f"ok {ok}  failed {failed}  ~{left:.0f} min left")
                if args.limit and fetched >= args.limit:
                    print(f"\nstopping at --limit {args.limit}")
                    break
    except KeyboardInterrupt:
        print("\ninterrupted -- everything fetched so far is cached, "
              "re-run to continue")
    finally:
        real_save()
        amap.save = real_save

    print(f"\n{ok} routed, {failed} with no route, {fetched} newly fetched "
          f"in {(time.time() - started) / 60:.1f} min")

    write_output(pairs, amap, failures)


def write_output(pairs, amap, failures):
    """Turn the raw cache into the file the map will actually ship with."""
    routes = {}
    raw_points = kept_points = 0

    for origin, destination in pairs:
        key = f"walk|{gcj(origin)}|{gcj(destination)}"
        payload = amap.cache.get(key)
        if not payload:
            continue
        try:
            route, _ = S.walking(gcj(origin), gcj(destination))
        except Exception:                                  # noqa: BLE001
            continue
        if route is None:
            continue

        raw_points += len(route["path"])
        path = compress_path(route["path"])
        kept_points += len(path)
        routes[f"{origin['id']}|{destination['id']}"] = {
            "d": route["distance_m"],
            "t": route["duration_s"],
            "p": path,
        }

    out = {
        "meta": {
            "source": "Amap /v3/direction/walking, precomputed",
            "coordinates": "WGS-84 [lat, lng], to match the basemap",
            "tolerance_deg": TOLERANCE,
            "decimals": DECIMALS,
            "pairs": len(routes),
            "failures": len(failures),
        },
        "routes": routes,
    }
    if failures:
        out["meta"]["failed_pairs"] = failures[:50]

    with io.open(OUT_PATH, "w", encoding="utf-8") as fh:
        json.dump(out, fh, separators=(",", ":"))

    on_disk = OUT_PATH.stat().st_size
    with io.open(OUT_PATH, "rb") as fh:
        gzipped = len(gzip.compress(fh.read(), 9))

    print(f"\nwrote {OUT_PATH.relative_to(ROOT)}")
    print(f"  {len(routes):,} routes")
    print(f"  {raw_points:,} points thinned to {kept_points:,} "
          f"({100 - kept_points * 100 / max(raw_points, 1):.0f}% dropped)")
    print(f"  on disk   {on_disk / 1024:>8,.0f} KB")
    print(f"  gzipped   {gzipped / 1024:>8,.0f} KB")
    if failures:
        print(f"\n  {len(failures)} pairs returned no route:")
        for f in failures[:5]:
            print(f"    {f['from']} -> {f['to']}: {f['error']}")


if __name__ == "__main__":
    main()
