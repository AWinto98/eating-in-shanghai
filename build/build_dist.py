"""Assemble the shippable builds.

Two editions come out of one codebase (see web/js/config.js for why):

  dist/site/                       the hosted link. Separate data files, so the
                                   lazy loading survives -- nobody pays for the
                                   2.4MB route table unless they plan a walk.

  dist/Eating-in-Shanghai.html     the download bundled with the purchase. One
                                   file, everything inlined, opens by double
                                   click with no server.

Both quote the guide's prose in full as of 2026-08-15, on the author's own
instruction. The editions still differ -- the buyer one drops the buy-the-guide
card for a thank-you -- but no longer in how much is quoted. See TEXT and
LANDING in web/js/config.js.

The single file exists because a page opened from file:// cannot fetch() at
all -- the data has to already be in the document. It also sidesteps the
Windows trap of running the page from inside the zip, where a folder build
loses its siblings.

Run:  python build/build_dist.py
"""

import base64
import io
import json
import os
import re
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
WEB = os.path.join(ROOT, "web")
DATA = os.path.join(ROOT, "data")
VENDOR = os.path.join(ROOT, "vendor", "leaflet")
DIST = os.path.join(ROOT, "dist")

# Exactly the data the page asks for. Everything else in data/ is working
# material -- the 21MB route cache, the geocoder cache, the review queues --
# and listing what goes in is safer than listing what stays out.
DATA_FILES = [
    "restaurants.geo.json",
    "routes.json",
    "basemap.index.json",
    "basemap.shanghai.json",
    "basemap.suzhou.json",
    "basemap.hangzhou.json",
]

# basemap.overview.json is built but not shipped. It covered zooms 8-10 for the
# old all-three-cities view; with one city on screen at a time nothing draws
# below zoom 11 and the map's minZoom says so. Putting it back is one line here
# plus the region entry in map.js -- basemap/build_basemap.py still makes it.
NOT_SHIPPED = ["basemap.overview.json"]

JS_FILES = ["config.js", "basemap.js", "map.js", "walk.js", "about.js"]

# Nothing here may ever reach a build.
FORBIDDEN = [".env", ".amap_key", "NOTES.md", "PLAN.md",
             "pin-lab.html", "basemap-lab.html", "route_cache.json",
             "geocode_cache.json", "review_queue.json"]


def read(path, binary=False):
    if binary:
        with open(path, "rb") as fh:
            return fh.read()
    with io.open(path, encoding="utf-8") as fh:
        return fh.read()


def write(path, text):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with io.open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write(text)


def kb(n):
    return f"{n / 1024:,.0f} KB"


def data_text(name):
    """A data file as it should ship.

    Only basemap.index.json differs from what is on disk: the unshipped regions
    are stripped out of it, so the index never advertises a file that is not
    there. Leaving them in would be a trap for anything that iterates it."""
    raw = read(os.path.join(DATA, name))
    if name != "basemap.index.json":
        return raw
    payload = json.loads(raw)
    dropped = [r["region"] for r in payload["regions"]
               if r["file"] in NOT_SHIPPED]
    payload["regions"] = [r for r in payload["regions"]
                          if r["file"] not in NOT_SHIPPED]
    if dropped:
        print(f"  index: dropped {', '.join(dropped)} (built, not shipped)")
    return json.dumps(payload, ensure_ascii=False, indent=1)


def leaflet_css():
    """Leaflet's stylesheet with its three images inlined.

    They are 3.4KB in total and only two of them are ever used (the layers
    control is not on this map). Inlining removes a whole class of broken-path
    bug in exchange for nothing worth measuring."""
    css = read(os.path.join(VENDOR, "leaflet.css"))
    for name in ("layers-2x.png", "layers.png", "marker-icon.png"):
        raw = read(os.path.join(VENDOR, "images", name), binary=True)
        uri = "data:image/png;base64," + base64.b64encode(raw).decode("ascii")
        css = css.replace(f"url(images/{name})", f"url({uri})")
    assert "url(images/" not in css, "a Leaflet image reference survived"
    return css


def js_string(text):
    """A JS string literal holding `text`.

    `<` becomes \\u003c so that a "</script>" occurring anywhere inside the
    data cannot end the enclosing script element early. That is a real risk:
    the payload is 6.8MB of text nobody has read end to end."""
    return json.dumps(text).replace("<", "\\u003c")


def guard_inline_js(code, name):
    """Raw JS going into a <script> element, checked rather than mangled.

    Escaping "</script" here would corrupt working code, so this refuses to
    build instead. No file trips it today; the check is for the day one does."""
    if "</script" in code.lower():
        raise SystemExit(f"{name} contains a literal </script and cannot be inlined")
    return code


def check_withheld(payload):
    """The three tour-only places must never become restaurants.

    Naively grepping the file is useless: the author's own Jiangnan intro names
    Tongxiang and says "I do those last three places by tour only -- no
    addresses!", and that sentence ships verbatim on purpose, because it is
    what tells a reader those places are off-limits. The thing that would be
    wrong is a *record* for one of them, so that is what is checked.
    """
    markers = ["tongxiang", "桐乡", "tour only", "100-year-old teahouse"]
    bad = []
    for rec in payload["restaurants"]:
        blob = json.dumps(rec, ensure_ascii=False).lower()
        hit = [m for m in markers if m in blob]
        if hit:
            bad.append((rec.get("name_en"), hit))
    if bad:
        raise SystemExit(f"withheld places present as records: {bad}")
    return len(payload["restaurants"])


def build_site():
    """The hosted build: index.html at the root, data beside it."""
    out = os.path.join(DIST, "site")
    if os.path.exists(out):
        shutil.rmtree(out)

    html = read(os.path.join(WEB, "index.html"))
    html = html.replace(
        '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">',
        '<link rel="stylesheet" href="vendor/leaflet.css">')
    html = html.replace(
        '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>',
        '<script src="vendor/leaflet.js"></script>')
    # Data sits beside index.html here, not a level up as in the source tree.
    html = html.replace(
        '<script src="js/config.js"></script>',
        '<script>window.DATA_BASE_OVERRIDE = "data/";'
        ' window.EDITION_OVERRIDE = "public";</script>\n'
        '<script src="js/config.js"></script>')
    write(os.path.join(out, "index.html"), html)

    # The hosted edition is unlisted: not linked from anywhere, and asking to
    # stay out of search results. Cloudflare Pages reads `_headers`.
    #
    # There is deliberately NO robots.txt, and adding one with `Disallow: /`
    # would make this worse rather than better. Disallow stops a crawler
    # *fetching* the page -- so it never sees the noindex header, and a URL that
    # turns up in a link or a certificate log can still be indexed as a bare
    # result. noindex only works on a page crawlers are allowed to read.
    #
    # This must be generated here rather than dropped into dist/site/ by hand:
    # build_site() rmtree's the whole folder on every run.
    write(os.path.join(out, "_headers"),
          "/*\n"
          "  X-Robots-Tag: noindex, nofollow\n")

    write(os.path.join(out, "vendor", "leaflet.css"), leaflet_css())
    shutil.copy2(os.path.join(VENDOR, "leaflet.js"),
                 os.path.join(out, "vendor", "leaflet.js"))

    os.makedirs(os.path.join(out, "css"), exist_ok=True)
    shutil.copy2(os.path.join(WEB, "css", "style.css"),
                 os.path.join(out, "css", "style.css"))
    os.makedirs(os.path.join(out, "js"), exist_ok=True)
    for name in JS_FILES:
        shutil.copy2(os.path.join(WEB, "js", name),
                     os.path.join(out, "js", name))

    os.makedirs(os.path.join(out, "data"), exist_ok=True)
    for name in DATA_FILES:
        write(os.path.join(out, "data", name), data_text(name))

    total = sum(os.path.getsize(os.path.join(dp, f))
                for dp, _, fs in os.walk(out) for f in fs)
    print(f"  dist/site/                    {kb(total)} across "
          f"{sum(len(fs) for _, _, fs in os.walk(out))} files")
    return out


def build_single():
    """The download: one self-contained HTML file."""
    html = read(os.path.join(WEB, "index.html"))

    # Stylesheets become <style> blocks.
    html = html.replace(
        '<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css">',
        "<style>\n" + leaflet_css() + "\n</style>")
    html = html.replace(
        '<link rel="stylesheet" href="css/style.css">',
        "<style>\n" + read(os.path.join(WEB, "css", "style.css")) + "\n</style>")

    # Leaflet becomes an inline script.
    leaflet_js = guard_inline_js(read(os.path.join(VENDOR, "leaflet.js")), "leaflet.js")
    html = html.replace(
        '<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>',
        "<script>\n" + leaflet_js + "\n</script>")

    # The data, as JSON strings parsed on first use rather than at load.
    parts = ['<script>', 'window.EDITION_OVERRIDE = "buyer";', 'window.BUNDLE = {']
    for name in DATA_FILES:
        text = data_text(name)
        if name == "restaurants.geo.json":
            n = check_withheld(json.loads(text))
            print(f"  {n} restaurants, none of them withheld")
        parts.append(f'{json.dumps(name)}: {js_string(text)},')
    parts.append('};')
    parts.append('</script>')
    bundle = "\n".join(parts)

    html = html.replace('<script src="js/config.js"></script>',
                        bundle + '\n<script src="js/config.js"></script>')

    # Then the application scripts themselves.
    for name in JS_FILES:
        code = guard_inline_js(read(os.path.join(WEB, "js", name)), name)
        html = html.replace(f'<script src="js/{name}"></script>',
                            "<script>\n" + code + "\n</script>")

    # Only real elements count. Searching the whole document for src=/href=
    # also finds the attribution links and the template literals that build
    # popup markup, none of which the browser ever loads.
    tags = re.findall(r'<(?:script|link|img|iframe|source)\b[^>]*>', html, re.I)
    external = []
    for tag in tags:
        for url in re.findall(r'(?:src|href)\s*=\s*"([^"]+)"', tag, re.I):
            if not url.startswith(("data:", "#")):
                external.append(url)
    if external:
        raise SystemExit(f"single-file build still loads {external}")

    out = os.path.join(DIST, "Eating-in-Shanghai.html")
    write(out, html)
    print(f"  dist/Eating-in-Shanghai.html  {kb(os.path.getsize(out))}, one file")
    return out


def audit(site_dir, single_file):
    print("\nAudit")
    bad = []
    for dirpath, _, names in os.walk(DIST):
        for n in names:
            if n in FORBIDDEN:
                bad.append(os.path.join(dirpath, n))
    print(f"  forbidden files in dist/: {bad if bad else 'none'}")

    for stray in ("extract", "geocode", "routes", "basemap", "vendor/leaflet/images"):
        p = os.path.join(site_dir, stray)
        if os.path.exists(p):
            bad.append(p)
    print(f"  build scripts copied in: {'YES -- ' + str(bad) if bad else 'none'}")

    single = read(single_file)
    for token in ("AMAP_KEY", "amap_key", "restapi.amap.com"):
        if token in single:
            print(f"  !! the single file contains {token!r}")
            bad.append(token)
    print(f"  Amap key or endpoint in the download: "
          f"{'FOUND' if any(t in single for t in ('AMAP_KEY', 'restapi.amap.com')) else 'none'}")

    if bad:
        raise SystemExit("audit failed")
    print("  clean")


def main():
    for name in DATA_FILES:
        if not os.path.exists(os.path.join(DATA, name)):
            raise SystemExit(f"missing data file: {name}")
    if not os.path.exists(os.path.join(VENDOR, "leaflet.js")):
        raise SystemExit("vendor/leaflet/ is missing -- see README")

    os.makedirs(DIST, exist_ok=True)
    print("Building")
    site = build_site()
    single = build_single()
    audit(site, single)
    print("\nOpen dist/Eating-in-Shanghai.html by double-clicking it.")
    print("Serve dist/site/ from its own root for the hosted version.")


if __name__ == "__main__":
    main()
