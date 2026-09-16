"""Geocode the extracted restaurants with Amap.

Reads `data/restaurants.json` (step 1's output) and writes
`data/restaurants.geo.json` with a `geo` block added to every restaurant.

Two lookup paths:

  * `/v3/geocode/geo`  -- the 51 entries that carry a Chinese address.
  * `/v3/place/text`   -- the chains whose directory record says "too many to
    list" (Xiao Yang, Tai'er). We take the single top-ranked branch, which
    keeps them consistent with the other 51 having one pin each.

Every response is cached on disk keyed by the query, not by restaurant, so
reruns cost zero API calls and re-parsing is free. The cache stores raw
responses, so changing the flagging rules below never costs a lookup.

Amap returns GCJ-02. Editorial basemaps are WGS-84, where GCJ-02 pins sit
300-600m off, so both coordinate systems are emitted and the basemap stays
swappable without touching steps 3-4.

Nothing is guessed: a lookup that fails, lands in the wrong city, or resolves
only to a road or district is written out with a flag and collected into
`data/geocode_review.json`.

Usage:
    python geocode/geocode.py [--refresh] [--only ID ...]
"""

import argparse
import json
import math
import os
import sys
import time
from pathlib import Path

import requests

BASE = "https://restapi.amap.com"
TIMEOUT = 10
ATTEMPTS = 3
DEFAULT_QPS = 3.0

CITY_CN = {"Shanghai": "上海", "Suzhou": "苏州", "Hangzhou": "杭州"}

# Amap `level` values, best to worst. Anything not in FINE_LEVELS resolves to
# something bigger than a building and gets flagged rather than trusted.
# `小巷` sounds coarse but is not: Amap tags a lane address that way while still
# resolving the full door, e.g. 乌鲁木齐中路318号乌中市集. All three here came
# back with the queried house number intact, so they count as found.
FINE_LEVELS = {"门址", "门牌号", "单元号", "兴趣点", "热点商圈", "小巷"}
POI_LEVEL = "兴趣点"

# These mean Amap never found the building and fell back to the centre of
# something larger -- the road-centroid failure NOTES.md already measured on
# Nominatim. 三林镇中林街65号 lands on the wrong 中林路, 54km out. A name lookup
# is tried before accepting any of them.
CENTROID_LEVELS = {
    "道路", "道路交叉路口", "村庄", "乡镇", "区县", "城市", "省",
    "开发区", "公交站台", "未知",
}

# Street names repeat across districts and cities -- 人民路1265号 returns ten
# candidates spread 56km, and 淮海中路999号 returns two 130m apart. Amap orders
# them most-specific-first, which is worth more than any local re-ranking: for
# 淮海中路999号 the top hit is the one that resolved the mall unit (L3-318) even
# though its `level` tag is no finer, and re-ranking on `level` picked the
# vaguer one. Both hand-verified addresses in NOTES.md are the top hit. So the
# ordering is trusted, and the alternates are recorded as data for step 3
# rather than second-guessed here.

# Key errors are worth stopping for -- retrying 53 times against a dead key
# just burns quota and fills the output with identical failures.
FATAL_INFOCODES = {
    "10001",  # INVALID_USER_KEY
    "10003",  # DAILY_QUERY_OVER_LIMIT
    "10004",  # ACCESS_TOO_FREQUENT
    "10005",  # INVALID_USER_IP
    "10009",  # USERKEY_PLAT_NOMATCH
    "10010",  # IP_QUERY_OVER_LIMIT
}


def load_key():
    """AMAP_KEY from the environment, else .env, else .amap_key. Never printed."""
    key = os.environ.get("AMAP_KEY", "").strip()
    if key:
        return key

    root = Path(__file__).resolve().parent.parent
    env = root / ".env"
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            name, _, value = line.partition("=")
            if name.strip() == "AMAP_KEY":
                return value.strip().strip("'\"")

    plain = root / ".amap_key"
    if plain.exists():
        return plain.read_text(encoding="utf-8").strip()

    sys.exit("No Amap key. Put AMAP_KEY=... in .env (it is gitignored).")


# --- GCJ-02 <-> WGS-84 ------------------------------------------------------

A = 6378245.0
EE = 0.00669342162296594323


def _out_of_china(lng, lat):
    return not (73.66 < lng < 135.05 and 3.86 < lat < 53.55)


def _tf_lat(x, y):
    ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(y * math.pi) + 40.0 * math.sin(y / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (160.0 * math.sin(y / 12.0 * math.pi) + 320 * math.sin(y * math.pi / 30.0)) * 2.0 / 3.0
    return ret


def _tf_lng(x, y):
    ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * math.sqrt(abs(x))
    ret += (20.0 * math.sin(6.0 * x * math.pi) + 20.0 * math.sin(2.0 * x * math.pi)) * 2.0 / 3.0
    ret += (20.0 * math.sin(x * math.pi) + 40.0 * math.sin(x / 3.0 * math.pi)) * 2.0 / 3.0
    ret += (150.0 * math.sin(x / 12.0 * math.pi) + 300.0 * math.sin(x / 30.0 * math.pi)) * 2.0 / 3.0
    return ret


def wgs84_to_gcj02(lng, lat):
    if _out_of_china(lng, lat):
        return lng, lat
    dlat = _tf_lat(lng - 105.0, lat - 35.0)
    dlng = _tf_lng(lng - 105.0, lat - 35.0)
    rad = lat / 180.0 * math.pi
    magic = 1 - EE * math.sin(rad) ** 2
    sqrt_magic = math.sqrt(magic)
    dlat = (dlat * 180.0) / ((A * (1 - EE)) / (magic * sqrt_magic) * math.pi)
    dlng = (dlng * 180.0) / (A / sqrt_magic * math.cos(rad) * math.pi)
    return lng + dlng, lat + dlat


def gcj02_to_wgs84(lng, lat):
    """Invert the offset numerically -- converges to well under a millimetre."""
    if _out_of_china(lng, lat):
        return lng, lat
    wlng, wlat = lng, lat
    for _ in range(8):
        glng, glat = wgs84_to_gcj02(wlng, wlat)
        dlng, dlat = glng - lng, glat - lat
        if abs(dlng) < 1e-9 and abs(dlat) < 1e-9:
            break
        wlng, wlat = wlng - dlng, wlat - dlat
    return wlng, wlat


# --- Amap client ------------------------------------------------------------


def _s(value):
    """Amap renders empty fields as [] or {}; flatten those to ''."""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, list) and value:
        return _s(value[0])
    return ""


class Amap:
    """Cached Amap client. Cache keys and log lines never contain the key."""

    def __init__(self, key, cache_path, refresh=False, qps=DEFAULT_QPS):
        self.key = key
        self.cache_path = cache_path
        self.refresh = refresh
        self.min_gap = 1.0 / qps if qps > 0 else 0.0
        self.last_call = 0.0
        self.calls = 0
        self.dirty = False
        self.cache = {}
        if cache_path.exists():
            try:
                self.cache = json.loads(cache_path.read_text(encoding="utf-8"))
            except json.JSONDecodeError:
                print(f"cache unreadable, starting fresh: {cache_path}")

    def fetch(self, path, params, cache_key):
        if not self.refresh and cache_key in self.cache:
            return self.cache[cache_key], True

        if self.min_gap:
            wait = self.min_gap - (time.monotonic() - self.last_call)
            if wait > 0:
                time.sleep(wait)

        payload = None
        for attempt in range(1, ATTEMPTS + 1):
            try:
                resp = requests.get(
                    BASE + path, params={**params, "key": self.key}, timeout=TIMEOUT
                )
                resp.raise_for_status()
                payload = resp.json()
                break
            except (requests.RequestException, json.JSONDecodeError) as exc:
                if attempt == ATTEMPTS:
                    payload = {"status": "0", "info": f"request failed: {exc}"}
                else:
                    time.sleep(attempt)
        self.last_call = time.monotonic()
        self.calls += 1

        infocode = _s(payload.get("infocode"))
        if infocode in FATAL_INFOCODES:
            self.save()
            sys.exit(
                f"Amap refused the request: {_s(payload.get('info'))} ({infocode}). "
                "Cache saved, so a rerun resumes where this stopped."
            )

        # Only successful lookups are cached; a transient failure should be
        # retried on the next run rather than frozen into the cache.
        if _s(payload.get("status")) == "1":
            self.cache[cache_key] = payload
            self.dirty = True
        return payload, False

    def save(self):
        if self.dirty:
            self.cache_path.write_text(
                json.dumps(self.cache, ensure_ascii=False, indent=2), encoding="utf-8"
            )
            self.dirty = False


# --- lookups ----------------------------------------------------------------


def parse_location(location):
    lng_s, _, lat_s = _s(location).partition(",")
    try:
        return float(lng_s), float(lat_s)
    except ValueError:
        return None


def metres_between(a, b):
    """Good enough at Shanghai's latitude for telling 50m from 50km apart."""
    (lng1, lat1), (lng2, lat2) = a, b
    mid = math.radians((lat1 + lat2) / 2)
    return math.hypot(
        (lng2 - lng1) * 111320 * math.cos(mid), (lat2 - lat1) * 110540
    )


def geocode_address(amap, address, city_cn):
    """`/v3/geocode/geo`. Falls back to a city-prefixed address on no result.

    Returns every candidate -- the caller decides between them.
    """
    queries = [(address, city_cn), (f"{city_cn}{address}", "")]
    last = None
    for i, (query, city) in enumerate(queries):
        params = {"address": query, "output": "JSON"}
        if city:
            params["city"] = city
        payload, cached = amap.fetch(
            "/v3/geocode/geo", params, f"geo|{city}|{query}"
        )
        last = payload
        results = [g for g in (payload.get("geocodes") or []) if parse_location(g.get("location"))]
        if _s(payload.get("status")) == "1" and results:
            candidates = [dict(g) for g in results]
            for hit in candidates:
                hit["_query"] = query
                hit["_count"] = len(results)
                hit["_cached"] = cached
                hit["_fallback"] = i > 0
            return candidates, None
    info = _s(last.get("info")) if last else "no response"
    return None, info or "no match"


def summarise_alternates(candidates):
    """The runners-up Amap ranked below the chosen hit, kept for step 3.

    Not a flag: a distant alternate is usually just the same street name in
    another district, which the top hit already rejected.
    """
    top = parse_location(candidates[0]["location"])
    out = []
    for other in candidates[1:]:
        point = parse_location(other["location"])
        out.append(
            {
                "formatted_address": _s(other.get("formatted_address")),
                "district": _s(other.get("district")),
                "level": _s(other.get("level")),
                "metres_away": round(metres_between(top, point)),
            }
        )
    return out


def search_poi(amap, keywords, city_cn):
    """`/v3/place/text`, top branch only -- the settled choice for chains."""
    params = {
        "keywords": keywords,
        "city": city_cn,
        "citylimit": "true",
        "offset": "1",
        "page": "1",
        "output": "JSON",
    }
    payload, cached = amap.fetch(
        "/v3/place/text", params, f"poi|{city_cn}|{keywords}"
    )
    pois = payload.get("pois") or []
    if _s(payload.get("status")) == "1" and pois:
        hit = dict(pois[0])
        hit["_query"] = keywords
        hit["_count"] = int(_s(payload.get("count")) or len(pois))
        hit["_cached"] = cached
        return hit, None
    info = _s(payload.get("info"))
    return None, info or "no match"


def build_geo(hit, method, expected_city_cn):
    """Normalise a geocode or POI hit into the `geo` block, with flags."""
    flags = []
    coords = parse_location(hit.get("location"))
    if coords is None:
        return None, ["unparseable_location"]
    lng, lat = coords
    wgs_lng, wgs_lat = gcj02_to_wgs84(lng, lat)

    if method == "geocode":
        level = _s(hit.get("level"))
        district = _s(hit.get("district"))
        city = _s(hit.get("city")) or _s(hit.get("province"))
        formatted = _s(hit.get("formatted_address"))
        matched_name = ""
    else:
        level = POI_LEVEL
        district = _s(hit.get("adname"))
        city = _s(hit.get("cityname")) or _s(hit.get("pname"))
        formatted = _s(hit.get("address"))
        matched_name = _s(hit.get("name"))
        # A chain pin is one branch of many by choice; a fallback pin replaced an
        # address that only resolved to a road, so it needs a different look.
        flags.append(
            "chain_top_branch" if method == "place_text" else "resolved_by_name"
        )

    if level and level not in FINE_LEVELS:
        flags.append("coarse_precision")
    if not level:
        flags.append("no_precision_level")
    if not district:
        flags.append("no_district")
    if expected_city_cn and city and expected_city_cn not in city:
        flags.append("city_mismatch")
    if hit.get("_fallback"):
        flags.append("city_prefixed_fallback")

    geo = {
        "method": method,
        "query": hit.get("_query", ""),
        "matched_name": matched_name,
        "formatted_address": formatted,
        "district": district,
        "city": city,
        "adcode": _s(hit.get("adcode")),
        "level": level,
        "result_count": hit.get("_count", 1),
        "gcj02": {"lng": round(lng, 6), "lat": round(lat, 6)},
        "wgs84": {"lng": round(wgs_lng, 6), "lat": round(wgs_lat, 6)},
        "flags": flags,
    }
    return geo, flags


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="src", default="data/restaurants.json")
    ap.add_argument("--out-dir", default="data")
    ap.add_argument("--cache", default="data/geocode_cache.json")
    ap.add_argument("--refresh", action="store_true",
                    help="ignore cached responses and re-query Amap")
    ap.add_argument("--only", nargs="*", metavar="ID",
                    help="geocode just these restaurant ids")
    ap.add_argument("--qps", type=float, default=DEFAULT_QPS)
    args = ap.parse_args()

    src = Path(args.src)
    if not src.exists():
        sys.exit(f"{src} not found - run extract/extract_pdf.py first.")

    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    payload = json.loads(src.read_text(encoding="utf-8"))
    restaurants = payload["restaurants"]
    wanted = set(args.only) if args.only else None

    # --only rewrites the same output file, so carry over the entries it skips
    # instead of blanking them.
    previous = {}
    out_path = out_dir / "restaurants.geo.json"
    if wanted is not None and out_path.exists():
        previous = {
            r["id"]: r.get("geo")
            for r in json.loads(out_path.read_text(encoding="utf-8"))["restaurants"]
        }

    amap = Amap(load_key(), Path(args.cache), refresh=args.refresh, qps=args.qps)

    cached_hits = 0
    try:
        for rec in restaurants:
            if wanted is not None and rec["id"] not in wanted:
                rec["geo"] = previous.get(rec["id"])
                continue

            city_cn = CITY_CN.get(rec["city"], "")
            alternates = []
            if rec["address_cn"]:
                method = "geocode"
                candidates, error = geocode_address(amap, rec["address_cn"], city_cn)
                hit = None
                if candidates:
                    hit = candidates[0]
                    alternates = summarise_alternates(candidates)
                    if _s(hit.get("level")) in CENTROID_LEVELS and rec["name_cn"]:
                        by_name, _ = search_poi(amap, rec["name_cn"], city_cn)
                        if by_name is not None:
                            hit, method = by_name, "place_text_fallback"
                            alternates = []
            elif rec["name_cn"]:
                # No address in the directory ("too many to list") -- the chains.
                method = "place_text"
                hit, error = search_poi(amap, rec["name_cn"], city_cn)
            else:
                hit, error, method = None, "no address and no Chinese name", "none"

            if hit is None:
                rec["geo"] = {"method": method, "error": error, "flags": ["geocode_failed"]}
                continue

            cached_hits += 1 if hit.get("_cached") else 0
            geo, _ = build_geo(hit, method, city_cn)
            if geo:
                geo["alternates"] = alternates
            rec["geo"] = geo or {
                "method": method, "error": "unparseable location",
                "flags": ["geocode_failed"],
            }
    finally:
        amap.save()

    done = [r for r in restaurants if r.get("geo") and "error" not in r["geo"]]
    failed = [r for r in restaurants if r.get("geo") and "error" in r["geo"]]
    flagged = [r for r in done if r["geo"]["flags"]]

    payload["restaurants"] = restaurants
    payload["geocoding"] = {
        "provider": "amap",
        "coordinate_systems": ["gcj02", "wgs84"],
        "geocoded": len(done),
        "failed": len(failed),
    }
    out_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    review = {
        "failed": [
            {"id": r["id"], "name_en": r["name_en"], "address_cn": r["address_cn"],
             "error": r["geo"]["error"]}
            for r in failed
        ],
        "flagged": [
            {"id": r["id"], "name_en": r["name_en"], "address_cn": r["address_cn"],
             "level": r["geo"]["level"], "district": r["geo"]["district"],
             "formatted_address": r["geo"]["formatted_address"],
             "flags": r["geo"]["flags"]}
            for r in flagged
        ],
    }
    review_path = out_dir / "geocode_review.json"
    review_path.write_text(
        json.dumps(review, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    levels = {}
    districts = {}
    for r in done:
        levels[r["geo"]["level"] or "(none)"] = levels.get(r["geo"]["level"] or "(none)", 0) + 1
        d = r["geo"]["district"]
        if d:
            districts[d] = districts.get(d, 0) + 1

    print(f"restaurants        {len(restaurants)}")
    print(f"geocoded           {len(done)}")
    print(f"  via geocode/geo  {sum(1 for r in done if r['geo']['method'] == 'geocode')}")
    print(f"  via place/text   {sum(1 for r in done if r['geo']['method'] == 'place_text')}"
          f"  (+{sum(1 for r in done if r['geo']['method'] == 'place_text_fallback')} fallback)")
    print(f"failed             {len(failed)}")
    print(f"api calls          {amap.calls}  (cache hits {cached_hits})")
    print("precision          " + ", ".join(
        f"{k} {v}" for k, v in sorted(levels.items(), key=lambda kv: -kv[1])))
    print(f"districts          {len(districts)}  " + ", ".join(
        f"{k} {v}" for k, v in sorted(districts.items(), key=lambda kv: -kv[1])))
    print(f"flagged for review {len(flagged) + len(failed)}  -> {review_path}")
    print(f"wrote              {out_path}")


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    main()
