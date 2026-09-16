"""Serve web/ and proxy Amap walking routes, so the key stays on this machine.

    python serve.py            # then http://localhost:8000/web/

**This is a development convenience, not a dependency.** Every walking route the
map can need is precomputed into data/routes.json by routes/backfill_routes.py,
and walk.js reads that file; the endpoint below survives as a fallback for pairs
the backfill did not cover, and because backfill_routes.py calls walking()
directly to build the table in the first place.

Everything under the project root is served as static files. One extra endpoint:

    GET /api/walking?origin=<lng,lat>&destination=<lng,lat>

Coordinates in and out are the GCJ-02 pair already stored in
`data/restaurants.geo.json`, because that is what Amap expects -- no conversion
needed on the way in. The reply is normalised to what the map actually needs,
with the returned polyline converted to WGS-84 so it lines up with the vector
basemap:

    {"distance_m": 1240, "duration_s": 900, "path": [[lat, lng], ...]}

The Amap client, its on-disk cache, its retry and rate limiting and its
coordinate transform are all imported from geocode/geocode.py rather than
reimplemented -- one place where the key is read and one transform to trust.
Cached routes are keyed by origin+destination, so re-planning the same walk
costs nothing.
"""

import json
import sys
import threading
import urllib.parse
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "geocode"))

import geocode as G  # noqa: E402  (needs the path above)

CACHE_PATH = ROOT / "data" / "route_cache.json"
PORT = 8000

amap = None
lock = threading.Lock()


def parse_polyline(steps):
    """Amap gives each step a ';'-separated 'lng,lat' string, in GCJ-02."""
    path = []
    for step in steps:
        for pair in G._s(step.get("polyline")).split(";"):
            if not pair:
                continue
            lng_s, _, lat_s = pair.partition(",")
            try:
                lng, lat = float(lng_s), float(lat_s)
            except ValueError:
                continue
            wgs_lng, wgs_lat = G.gcj02_to_wgs84(lng, lat)
            point = [round(wgs_lat, 6), round(wgs_lng, 6)]
            if not path or path[-1] != point:
                path.append(point)
    return path


def walking(origin, destination):
    params = {"origin": origin, "destination": destination, "output": "JSON"}
    with lock:
        payload, _ = amap.fetch(
            "/v3/direction/walking", params, f"walk|{origin}|{destination}"
        )
        amap.save()

    if G._s(payload.get("status")) != "1":
        return None, G._s(payload.get("info")) or "no route"

    paths = (payload.get("route") or {}).get("paths") or []
    if not paths:
        return None, "no walking route between these two"

    best = paths[0]
    return {
        "distance_m": int(float(G._s(best.get("distance")) or 0)),
        "duration_s": int(float(G._s(best.get("duration")) or 0)),
        "path": parse_polyline(best.get("steps") or []),
    }, None


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path == "/api/walking":
            self.handle_walking(urllib.parse.parse_qs(parsed.query))
            return
        super().do_GET()

    def handle_walking(self, query):
        origin = (query.get("origin") or [""])[0]
        destination = (query.get("destination") or [""])[0]
        if not origin or not destination:
            self.send_json({"error": "origin and destination are required"}, 400)
            return
        try:
            route, error = walking(origin, destination)
        except Exception as exc:                      # noqa: BLE001
            self.send_json({"error": f"{type(exc).__name__}: {exc}"}, 502)
            return
        if route is None:
            self.send_json({"error": error}, 502)
            return
        self.send_json(route)

    def send_json(self, payload, status=200):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt, *args):
        # Quiet about static files; routing is the only interesting traffic.
        if "/api/" in (args[0] if args else ""):
            super().log_message(fmt, *args)


def main():
    global amap
    amap = G.Amap(G.load_key(), CACHE_PATH)
    cached = len(amap.cache)
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"serving {ROOT}")
    print(f"  map     http://localhost:{PORT}/web/")
    print(f"  pin lab http://localhost:{PORT}/web/pin-lab.html")
    print(f"  routes  /api/walking  ({cached} cached)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nstopping")
    finally:
        with lock:
            amap.save()


if __name__ == "__main__":
    main()
