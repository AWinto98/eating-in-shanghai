# data/

**This directory is intentionally empty in the repository.**

Everything that normally lives here is derived from *Guide to Eating in Shanghai
2026* by Christopher St. Cavish — his selections, his descriptions, his
categories. That is his paid work, so neither the guide nor anything extracted
from it is published here. Only the code that reads it is.

To use this project you need your own copy of the guide:

**<https://stcavish.gumroad.com/l/yllgxi>**

Put the PDF in the project root, then generate everything locally:

```
pip install -r requirements.txt
python extract/extract_pdf.py      # -> restaurants.json, restaurants.csv, review_queue.json
python geocode/geocode.py          # -> restaurants.geo.json  (needs AMAP_KEY in .env)
python serve.py                    # then http://localhost:8000/web/
```

`extract_pdf.py` takes `--pdf PATH` if your copy is named differently.

## What gets written here

| file | from | what it is |
| --- | --- | --- |
| `restaurants.json` | step 1 | the extracted entries — the contract for step 2 |
| `restaurants.csv` | step 1 | the same, for eyeballing in a spreadsheet |
| `review_queue.json` | step 1 | entries the parser could not fully resolve |
| `restaurants.geo.json` | step 2 | the above plus coordinates — what the map reads |
| `geocode_review.json` | step 2 | geocoding results worth a human check |
| `geocode_cache.json` | step 2 | cached Amap responses, so reruns cost no API calls |
| `route_cache.json` | step 4 | cached walking routes, same reason |

The geocoding and routing steps need a free Amap key in `.env` as
`AMAP_KEY=...`. See the main README for why Amap rather than an OSM-based
provider.
