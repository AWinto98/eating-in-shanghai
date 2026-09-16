# Eating in Shanghai — an interactive map

Reads *Guide to Eating in Shanghai 2026* by Christopher St. Cavish into
structured data, geocodes every address, and renders it as a map with a
walking-route planner — three cities, 53 restaurants, no API key and no tiles
from anyone else's server.

The finished page has no runtime dependencies at all. Every walking route is
precomputed, the basemap is built from OpenStreetMap into flat JSON, and Leaflet
is vendored, so the whole thing runs from a folder or from a single
double-clicked HTML file with no network.

## You need your own copy of the guide

**This repository contains the code only.** The restaurant selections and every
word of the descriptions are Christopher St. Cavish's paid work, so neither the
PDF nor anything derived from it is published here — `data/` is empty in the
repo and the PDF is gitignored.

Buy the guide: **<https://stcavish.gumroad.com/l/yllgxi>**

Put the PDF in the project root and the pipeline rebuilds everything locally.
See [`data/README.md`](data/README.md).

## The pipeline

Each step writes a file the next step reads, so they run and iterate
independently.

```
 the PDF ──▶ extract/extract_pdf.py   ──▶ data/restaurants.json
         ──▶ geocode/geocode.py       ──▶ data/restaurants.geo.json
         ──▶ routes/backfill_routes.py──▶ data/routes.json
 OSM     ──▶ basemap/build_basemap.py ──▶ data/basemap.<region>.json
                                          │
                web/  ◀───────────────────┘   the map itself
                  │
                  └─▶ build/build_dist.py ──▶ dist/site/, dist/*.html
```

```
pip install -r requirements.txt
python extract/extract_pdf.py
python geocode/geocode.py          # needs AMAP_KEY in .env
python basemap/build_basemap.py    # slow: large Overpass queries, cached
python routes/backfill_routes.py   # ~65 min, quota-bound
python serve.py                    # then http://localhost:8000/web/
```

Steps 3 and 4 are one-offs. Once `routes.json` and the basemap files exist, the
map needs neither a key nor a server.

## Step 1 — extraction

```
python extract/extract_pdf.py
```

Writes `data/restaurants.json`, `data/restaurants.csv` and
`data/review_queue.json`. **53 restaurants** — 47 in Shanghai, 3 in Suzhou,
3 in Hangzhou.

How it reads the guide:

* 60pt spans are cuisine section dividers, 24pt spans are front-matter headers.
* The address directory at the back is the authoritative roster — each record is
  three lines (English name / Chinese name + Chinese address / English address
  gloss), anchored on the line containing CJK.
* In the body, restaurant names are always bold. A bold run occupying its own
  line is a heading and its name is dropped from the notes; a bold run inside a
  sentence is an inline mention and keeps the sentence around it. Paragraphs
  listing several places are split at each name.
* Bold text that does not match a directory name is treated as a sub-header,
  never as a restaurant.
* `(Details)` link annotations are attributed to the entry owning the text above
  them, giving each restaurant its Dianping URL.

The subsetted fonts emit Kangxi radicals and CJK Radicals Supplement characters
where unified ideographs are meant (`⻄藏南路` for `西藏南路`). NFKC handles the
first block; `RADICALS` in the extractor covers the second, and the script warns
if an unmapped one survives.

**Three places are deliberately absent, and must stay that way.** The author
gives no address for lamb noodles in Tongxiang, an unnamed 100-year-old teahouse
and a pork restaurant — he does those by tour only. They produce no records
because the extractor treats the back-of-book directory as the authoritative
roster and never promotes unmatched bold text to a restaurant. A sweep of all 71
pages found no other withholding statement.

Nothing is guessed. Anything incomplete lands in `data/review_queue.json` with a
flag:

| flag | meaning |
| --- | --- |
| `no_body_entry` | in the directory but never written about |
| `missing_address_cn` | the guide says "too many to list" |
| `missing_address_en` / `missing_name_en` | directory record incomplete |
| `empty_notes` | matched a heading but captured no prose |
| `no_dianping_link` | no `(Details)` link in the entry |
| `category_from_front_matter` | only appears under "What's New", so the category came from the directory group rather than a cuisine section |

## Step 2 — geocoding

```
python geocode/geocode.py
```

Reads `data/restaurants.json`, writes `data/restaurants.geo.json` (every
restaurant gains a `geo` block) and `data/geocode_review.json`. **53 of 53
resolve, all to building level**, across 13 districts.

* The 51 entries with a Chinese address go through `/v3/geocode/geo`. Amap orders
  candidates most-specific-first and that ordering is trusted — for
  `淮海中路999号环贸广场L3-318` the top hit is the one that resolved the mall unit.
  Re-ranking locally by `level` was tried and made things worse. Runners-up are
  kept in `geo.alternates` rather than discarded.
* The two chains whose directory record says "too many to list" (Xiao Yang,
  Tai'er) go through `/v3/place/text`, taking the single top-ranked branch so
  they stay consistent with the other 51 having one pin each.
* When an address only resolves to a road centroid, the restaurant's Chinese name
  is looked up instead. `三林镇中林街65号` matched the wrong `中林路` and landed
  54km out; the name lookup returns the guide's exact address.
* `小巷` is **not** treated as coarse. Amap tags lane addresses that way while
  still resolving the full door number. `道路` and worse genuinely mean the
  building was not found, and trigger the name fallback.
* Every response is cached in `data/geocode_cache.json`, keyed by query rather
  than by restaurant, so reruns cost zero API calls. Raw responses are stored, so
  changing the flagging rules is free. Only successful lookups are cached — a
  transient failure retries next run.

Both coordinate systems are emitted. Amap returns GCJ-02; editorial basemaps are
WGS-84, where GCJ-02 pins sit 464–522m off in a way that reads as a bug. The
guide contains no district information at all, so geocoding is the only source
for the district filter.

| flag | meaning |
| --- | --- |
| `geocode_failed` | no result — nothing is guessed |
| `coarse_precision` | resolved to something bigger than a building |
| `chain_top_branch` | one branch of a chain that has no single address |
| `resolved_by_name` | the address gave a road centroid, so the name was used |
| `city_mismatch` | landed outside the city the directory gives |
| `city_prefixed_fallback` | only matched once the city was prepended |

`--refresh` re-queries Amap, `--only ID ...` redoes single entries, `--qps`
throttles.

**Why Amap and not an OSM-based geocoder.** Measured against the real addresses:
Nominatim on full addresses scored 0/10, Photon 3/10 with one result in Chiba,
Japan. Nominatim on street names alone got 8/8 but only to street-segment
centroids. Anything OSM-derived — LocationIQ, Geoapify, OpenCage — shares that
data and fails the same way.

## Step 3 — the basemap

```
python basemap/build_basemap.py [region ...]
```

Builds a minimal vector basemap from OpenStreetMap: water, green space and a
three-tier road network for the box around each region's pins, plus a
`data/basemap.index.json` describing them.

**This exists because CARTO's tiles are free to use but not free to redistribute
in a paid download.** OSM data is ODbL — free commercially, with attribution.

| region | on disk | note |
| --- | --- | --- |
| Shanghai | 2,114 KB | loads at startup |
| Suzhou | 363 KB | on first switch |
| Hangzhou | 999 KB | on first switch |
| overview | 977 KB | built, **not shipped** — see below |

Against roughly 26MB for the equivalent raster tiles (Shanghai's box is 2,176
tiles to z16), so about an eighth the size, in one file per region rather than
thousands, and legally ours to ship.

* **Output is deliberately not GeoJSON.** A `FeatureCollection` wrapper costs
  ~60 bytes of boilerplate per feature, about a megabyte across 17k features.
  Each layer is a flat list of coordinate rings; a ring whose first point equals
  its last is a polygon, everything else is a line. Simplified to ~3m at 5
  decimal places.
* **Regions are separate files, loaded on demand.** One box spanning all three
  cities would be roughly twelve times the area for six more restaurants.
* **Queries must ask for relations, not just ways.** A river or large park in OSM
  is usually a multipolygon whose tag sits on the relation while its outline is
  split across untagged member ways. With `way[...]` only, **24% of the Huangpu
  had no water surface beneath it** and the river rendered with holes. Members
  are stitched by exact endpoint match — they share node ids, so a real join is
  identical to the last decimal and a tolerance would fuse two banks that never
  meet. Only `outer` members are kept, since the renderer fills each ring on its
  own and an inner ring would paint a puddle inside its own lake.
* **The Overpass cache key includes the query.** It did not once, and a stale hit
  under a filename like `shanghai_water.json` silently returned the previous
  answer whenever a query was edited. That is what hid the relations bug.
* **The overview region is built but no longer shipped.** It covered zooms 8–10
  for an earlier all-three-cities view; with one city on screen at a time nothing
  draws below zoom 11. `NOT_SHIPPED` in `build/build_dist.py` plus a region entry
  in `map.js` puts it back.

Fetching is cached in `basemap/cache/` (~24MB, gitignored). Delete it to refresh
from OSM.

## Step 4 — walking routes

```
python routes/backfill_routes.py --dry-run   # count the work, spend nothing
python routes/backfill_routes.py             # do it
```

Fetches every walking route the map could ever need, once, and ships the
answers: **2,174 routes, zero failures, about 65 minutes** into
`data/routes.json`.

The map planned walks live at one point, via `/api/walking` in `serve.py`. That
could not ship — it would mean handing out the Amap key or paying for every
reader's routes forever, and readers cannot bring their own key because Amap
requires Alipay real-name verification.

* **Pairs are directed and within-city.** Within-city because nobody walks
  Shanghai→Hangzhou: 2,174 pairs rather than 2,756. Directed because the
  asymmetry is real — four pairs involving Sanlin Benbang Guan route roughly
  twice as far *to* it as *from* it, since it sits across the Huangpu where
  pedestrian crossings are sparse and Amap picks different ones by direction.
* **Routes come from `serve.walking()`** rather than a reimplementation, so what
  is baked in is byte-for-byte what the live proxy returns — same candidate
  choice, same GCJ-02→WGS-84 conversion.
* **Resumable** through `data/route_cache.json`, and cache writes are batched:
  `serve.walking()` rewrites the whole file per call, which is fine for one
  browser request and quadratic for thousands.
* Polylines are thinned with the same Douglas-Peucker as the basemap at ~2m —
  365,373 points down to 112,876, **69% dropped**, invisible at walking zoom.
* `--qps` is a ceiling, not a speed. Each call still pays Amap's ~1.8s round
  trip, so observed throughput was ~0.55/s.

Verified across all 2,174: median walking speed 4.5 km/h, path ends land a median
10m from the restaurant, detour ratio median 1.19 against the straight line, and
nothing is shorter than its own straight line.

**Why Amap and not OpenRouteService or OSRM.** The public OSRM demo returns the
car profile for `foot` — 1763m in 2.7 minutes is 39 km/h. Amap returns 958m in
766s between two of the soup-dumpling places, which is 4.5 km/h and a real
walking pace. OpenRouteService has a genuine `foot-walking` profile but runs on
the same OSM data that scored 0/10 on these addresses.

## Step 5 — the map

```
python serve.py            # then http://localhost:8000/web/
```

Leaflet, the vector basemap above, no build step, no API key. `serve.py` is a
development convenience now rather than a dependency — it serves the project
statically and exposes `/api/walking` as a fallback for pairs the backfill did
not cover.

### Three maps, not one

A city switcher at the top of the panel gives Shanghai (47), Suzhou (3) and
Hangzhou (3), one at a time. This matched the data rather than fighting it:

* **The route table is within-city only**, so on a combined map a walk spanning
  two cities had no route to draw and fell through to an error in the shipped
  build. Now it cannot be asked for.
* **The filters were only ever a Shanghai thing.** Suzhou and Hangzhou are three
  places each, all Jiangnan, and all six 2026 additions are in Shanghai — so
  "New in 2026" showed zero in both. Those cities get the guide's Jiangnan
  section intro and a list of their three places instead of four controls that
  could not change what was on screen.
* **A walk is kept per city**, so looking up Suzhou mid-plan does not cost you
  the Shanghai walk.

### Rendering

* **Ink** is the shipped style: monochrome and printed, roads as thin dark
  strokes rather than pale fills — closer to a map in the back of a book, and the
  strongest contrast with the vermilion pins. Positron-like and Guide remain in
  the lab so a later change of mind can be judged rather than guessed at.
* **Labels are drawn onto the basemap canvas, not as markers.** A marker lives in
  a different pane from the geometry, so during a zoom the roads scale with the
  pane while the marker does not — the label visibly lags and then snaps. On the
  canvas they share a paint operation and cannot come apart. They also get a halo
  in the page colour so they stay readable across a road.
* **Light by design, not by default.** The guide leans on white space, so the
  page ignores `prefers-color-scheme` — an OS set to dark still gets the light
  page. A toggle in the panel footer opts into dark and the choice persists.
* **Seal markers** — a vermilion name-chop drawn as inline SVG in a `divIcon`.
  It is symmetric, so the address is the centre of the mark and `iconAnchor` is
  its middle; a pointed shape like a teardrop would anchor at the tip instead.
  The SVG fills from the CSS tokens, so switching theme re-inks every pin with no
  JavaScript.
* **One pin colour — vermilion `#c8322a`** (`#e0584a` in dark). With 11
  categories a categorical palette stops being decodable at pin size, so category
  is carried by the filter list, which doubles as the legend.
* **Pins sharing an address** (Jingmei and Bastard are both at 延平路128号) are
  nudged apart so both stay clickable, and each says so in its popup.
  `geo.wgs84` in the data is untouched.

### Things that will bite if you edit it

* **`minZoom` is measured, not constant.** `fenceToRegion()` computes it per city
  *and per viewport*, because "from which zoom is this region drawn?" and "from
  which zoom does it fill the screen?" are different questions — conflating them
  let you pan off the edge of the data onto bare page colour. It is re-measured
  on resize, on rotation and when the panel collapses, since all three change the
  map size. The literal `11` in the `L.map()` options is only a starting value.
* **The floor is `min(cover, fit)`.** Hangzhou's box is wide relative to the map
  while its pins are tall, so covering the box takes z14.08 while showing its
  three pins takes z13.99 — nothing stops those crossing. A restaurant you cannot
  see is a worse bug than a white margin.
* **A fractional `minZoom` needs `zoomSnap: 0`.** Leaflet's `_limitZoom()` rounds
  a target onto the snap grid *before* clamping to `minZoom`, so with the default
  snap of 1 the wheel could not reach a floor at z13.02 while the zoom buttons
  could.
* **`scrollWheelZoom: "center"`** — the wheel is anchored to the pointer, so
  zooming out about the cursor pushes the centre away from it and `maxBounds`
  drags it straight back. Near the floor that correction fired on every notch.
  Dragging and pinch are untouched.
* **Leaflet silently drops large zoom animations.** `fitTo()` only animates hops
  of two levels or less.
* **Collapsing the panel** sets `inert` so focus cannot land in a hidden panel,
  and calls `map.invalidateSize()` once the transition ends — Leaflet caches the
  container size.
* **The opening view trims the outermost 5% of pins** in Shanghai, or Jiading
  (16km), Baoshan (14km) and Sanlin (10.6km) dictate the zoom and squeeze the
  other 44 into a blob downtown. The trim is skipped for the two three-pin
  cities, where dropping 5% would mean dropping a place.

### Mobile

* **The `<select>` must stay at 16px or larger.** Safari zooms the whole page
  when a control under 16px takes focus, and does not zoom back.
* **Do not nest a scroll container inside the popup.** The notes had their own
  190px scroller inside the popup's 42vh one; iOS locks a gesture to the first
  scrollable ancestor and will not hand off to the parent mid-drag, so dragging
  the prose left the popup still and put "Add to walk" permanently below the
  fold. The inner cap is dropped on mobile and kept on desktop, where there is no
  outer cap and a 973-character entry would otherwise run off the map.
* **Feedback has to be where the thumb is.** Adding a stop from a popup looked
  like it did nothing on a phone, because all three feedback channels are hidden
  at the moment of the tap — the walk list and the summary are in a panel that is
  collapsed or scrolled past, and the pin's selected state is under the popup. The
  popup button now reports its own state, the panel handle carries a count badge,
  and the walk section scrolls itself into view.

### Planning a walk

There is no route "mode". Every popup has **Add to walk**; the itinerary panel
appears once there is something in it. From there you can reorder by hand,
drop stops, or press **Best order**.

* **Legs are looked up in `data/routes.json`** by `fromId|toId`. The table loads
  lazily on the first walk rather than at startup, since 2.4MB should not be
  charged to someone who never plans one.
* **Best order uses real walking distance.** `bestOrder()` works on ids through
  `stopDistance()`, which prefers the table and falls back to straight line, and
  is directional so the Sanlin asymmetry is respected. The solver is
  nearest-neighbour from every possible start, then 2-opt, which is exact well
  past the 12-stop cap.
* It is an **open path, not a loop** — a walk ends at the last restaurant.
* **A stop hidden by the filters stays in the walk** and says so.
* **Only show my walk** *overrides* the filters rather than intersecting with
  them — otherwise a category filter could hide a stop from the very walk you
  asked to look at — so the filter controls are dimmed and made `inert` while it
  is on. It releases itself if the walk empties.
* **One degenerate case:** Jingmei→Bastard is 1m with a single path point, since
  they share an address. `drawRoute()`'s `points.length < 2` guard covers it.

## Step 6 — the builds

```
python build/build_dist.py
```

Two editions from one codebase:

| | what | for |
| --- | --- | --- |
| `dist/site/` | 16 files, separate data | hosting. Lazy loading survives |
| `dist/Eating-in-Shanghai.html` | one file, everything inlined | double-click, no server |

The single file exists because a page opened from `file://` cannot `fetch()` at
all — the data has to already be in the document. It also sidesteps the Windows
trap of running the page from inside the zip, where a folder build loses its
siblings.

* **One `loadJSON()` in `config.js`** does it. When `window.BUNDLE` is present it
  reads from there, otherwise it fetches exactly as before, so the two builds
  cannot drift. Payloads are stashed as JSON **strings** and parsed on first use
  — parsing 6.8MB up front to answer a 1.5KB index would stall the page.
* **Leaflet is vendored** to `vendor/leaflet/`, with its three CSS images inlined
  as data URIs so no path can break.
* **The build audits itself**: no `.env`, no PDF, no pipeline scripts, no labs, no
  Amap key or endpoint anywhere in the output. It also proves the three withheld
  places produce no *records* — grepping for their names is useless, because the
  author's own Jiangnan intro names Tongxiang on purpose and ships verbatim.

Everything a reader might want changed lives in **`web/js/config.js`**: which
edition, how much of the prose is quoted, the landing card's wording, the buy
link. One line each, by design.

## Attribution

The restaurant selections and every description are **Christopher St. Cavish's**,
from his *Guide to Eating in Shanghai 2026*. This project is the map around them:
reading the guide into data, geocoding, the basemap and the walking-route
planner.

* `web/js/config.js` holds the author, title and purchase link in one place, so
  the credit on the landing card and in every popup cannot drift apart.
* Each popup carries the credit **under the quoted words**, because a screenshot
  of a card travels without the landing page attached.
* The landing card states that the map is made with the author's permission, and
  that three places are deliberately absent. It shows on first visit and is
  reachable afterwards from "About" in the panel footer.
* The basemap is © OpenStreetMap contributors, **ODbL**, credited on the map.

`TEXT` in `config.js` controls how much of the guide each popup quotes. The
extract path — whole sentences up to a bound, never a mid-word cut — is kept
working whatever that is set to.

## Licence

The **code** in this repository is MIT licensed — see [`LICENSE`](LICENSE).

That covers the code and nothing else, which is the distinction worth being
clear about:

* **The guide's content is Christopher St. Cavish's**, all rights reserved. It is
  not in this repository and the MIT grant does not extend to it. Running this
  pipeline against your own copy produces a map of *his* writing on your own
  machine; publishing that is his call, not this licence's.
* **The basemap data is © OpenStreetMap contributors, ODbL.** Anything built from
  `basemap/build_basemap.py` carries that licence and its attribution
  requirement, which the map displays.
* **Leaflet** in `vendor/` is BSD-2-Clause, under its own copyright.

## Labs

```
http://localhost:8000/web/pin-lab.html
http://localhost:8000/web/basemap-lab.html
```

Scratch pages for choosing the marker shape and comparing basemap palettes. Both
load the same data and the same tokens as the map — the pin lab draws all 47
Shanghai pins in whichever of 12 shapes you pick, because what decides a marker
is how it reads as a crowd, not how one looks alone, and it prints the
`viewBox`, size and `iconAnchor` to paste into `PIN_SVG` / `PIN_SIZE`. The
basemap lab compares the renderer that actually ships, since palettes and labels
live in `web/js/basemap.js` and are shared.

Nothing in the map depends on either file, and neither is included in a build.

## Category reassignment

"The New Ones (2026)" was a time axis competing with the cuisine ones, so the 6
are moved onto the cuisine axis in `RECATEGORISE` (`web/js/map.js`) and keep
their recency as a badge. Each target has a precedent in the guide's own
taxonomy — `Regional` is where a province's cuisine done in Shanghai lives, and
Chai Mi Duo, also Yunnan, is filed exactly that way.

| entry | the notes say | → |
| --- | --- | --- |
| Sheng Ji | Shunde congee | Regional |
| Ye Shan Tong | "a Jiangxi chain" | Regional |
| Guo Guo | Guizhou rice dishes | Regional |
| In and Out | Yunnan | Regional |
| Xiao Tao | spring onion noodles | Noodles |
| Yun He | Shanghai/Suzhou noodles | Noodles |

This happens in the web layer, so `data/restaurants.geo.json` keeps the guide's
own categories and the change is one object to revert.

## What is not in this repository

`data/` (everything derived from the guide), the PDF itself, `dist/` (the builds
inline the prose), `basemap/cache/` (~24MB of raw Overpass responses,
rebuildable) and `.env` (the Amap key, which is needed only to *rebuild* the
data — the finished map uses none).
