/* The vector basemap: renderer, palettes and hand-set labels.
 *
 * Replaces CARTO's raster tiles. Theirs are free to *use* but not free to
 * bundle into a paid download; this is built from OpenStreetMap, which is ODbL
 * -- free commercially, with attribution. Built by basemap/build_basemap.py.
 *
 * Shared by map.js and basemap-lab.html so the thing being compared in the lab
 * is literally the thing that ships.
 *
 * Two decisions worth knowing:
 *
 * Leaflet's own vector layers make one Layer object per shape, which is fine
 * for a hundred and hopeless for twenty-two thousand. This is a single canvas
 * that draws every ring itself. Each point is projected once at zoom 0 on load,
 * so a redraw is a multiply and a subtract per point rather than a projection.
 *
 * Labels are drawn onto that same canvas rather than as markers. A marker lives
 * in a different pane from the geometry, so during a zoom the roads scale with
 * the pane while the marker does not -- the label visibly lags and then snaps.
 * On the canvas they share a paint operation and cannot come apart.
 */

/* Painted in this order. Roads last so they sit over water and parks. */
const BASEMAP_LAYER_ORDER = [
  "water", "green", "roads_tertiary", "roads_secondary", "roads_major",
];

/* Below these, a layer is noise rather than information. */
const BASEMAP_MIN_ZOOM = {
  water: 0, green: 11, roads_major: 0, roads_secondary: 12, roads_tertiary: 13,
};

const BASEMAP_PRESETS = {
  /* Chosen 2026-08-09. Monochrome and printed -- roads as thin dark strokes
     rather than pale fills, which is how a map in the back of a book reads,
     and gives the strongest contrast with the vermilion seals. */
  ink: {
    id: "ink",
    name: "Ink",
    /* Water was #eeece6, which is 1.12:1 against its own land -- fainter than
       the tertiary road tier at 1.42:1. The Huangpu is the largest single
       feature in Shanghai and it was the lowest-contrast thing on the map,
       which is why it read as a smudge rather than a river. Re-stepped to
       1.38:1, about level with a minor road: present, still quiet, still
       monochrome. The outline has to move with it, or it ends up lighter than
       the fill it is supposed to edge. */
    light: {
      page: "#faf9f6", water: "#dad6ca", waterLine: "#cbc6b8",
      green: "#f2f1ea", greenLine: null,
      major: "#b3aea1", secondary: "#c6c2b6", tertiary: "#d6d3c9",
      labelInk: "#3d3a33", labelMuted: "#8a8579", labelHalo: "#faf9f6",
    },
    dark: {
      page: "#0d0d0d", water: "#282824", waterLine: "#333330",
      green: "#141412", greenLine: null,
      major: "#3a3a35", secondary: "#2b2b27", tertiary: "#212120",
      labelInk: "#c3c2b7", labelMuted: "#8a8579", labelHalo: "#0d0d0d",
    },
    widths: { major: 1.3, secondary: 0.8, tertiary: 0.5 },
  },

  /* Kept for comparison in the lab. Mimics the CARTO look the map used to
     borrow, and is the control the chosen style had to beat. */
  positron: {
    id: "positron",
    name: "Positron-like",
    light: {
      page: "#fafaf8", water: "#d4dadc", waterLine: "#c6cdd0",
      green: "#e6e9e0", greenLine: null,
      major: "#ffffff", secondary: "#ffffff", tertiary: "#ffffff",
      casing: "#e0ded6",
      labelInk: "#5c5c58", labelMuted: "#7d8a8f", labelHalo: "#fafaf8",
    },
    dark: {
      page: "#121212", water: "#1b2225", waterLine: "#222b2f",
      green: "#161a16", greenLine: null,
      major: "#2a2a28", secondary: "#242422", tertiary: "#1e1e1c",
      casing: "#0d0d0d",
      labelInk: "#b9b9b2", labelMuted: "#7d8a8f", labelHalo: "#121212",
    },
    widths: { major: 2.4, secondary: 1.5, tertiary: 0.9 },
  },

  guide: {
    id: "guide",
    name: "Guide",
    light: {
      page: "#f9f9f7", water: "#e4e9ea", waterLine: "#d5dcde",
      green: "#eceee6", greenLine: null,
      major: "#d9d7cf", secondary: "#e2e0d8", tertiary: "#e8e6de",
      labelInk: "#52514e", labelMuted: "#8b9599", labelHalo: "#f9f9f7",
    },
    dark: {
      page: "#0d0d0d", water: "#161c1f", waterLine: "#1d262a",
      green: "#121612", greenLine: null,
      major: "#2e2e2b", secondary: "#232321", tertiary: "#1c1c1a",
      labelInk: "#c3c2b7", labelMuted: "#7d8a8f", labelHalo: "#0d0d0d",
    },
    widths: { major: 1.7, secondary: 1.0, tertiary: 0.6 },
  },
};

const BASEMAP_SHIPPED_PRESET = "ink";

/* The one thing OSM geometry does not give us. On an editorial map a sparse
 * hand-set label reads as intent rather than as a shortfall.
 *
 * VERIFIED 2026-08-12 against OSM. Every district label was confirmed to fall
 * inside the district it names, using Overpass `is_in` on the exact coordinate
 * rather than a distance to a centroid -- a bounding-box centre is meaningless
 * for shapes like Pudong, whose relation runs 70km out to sea.
 *
 * The eight district positions are kept as originally set. They sit 0.2-2.4km
 * from OSM's own label-role nodes, which is well inside districts 4-8km across,
 * and they clear the restaurant pins slightly better than OSM's do. Moving them
 * would have traded a defensible source for new collisions.
 *
 * Water and place labels were the ones actually wrong, and are now sourced. */
const BASEMAP_LABELS = {
  shanghai: [
    { text: "HUANGPU",    lat: 31.2270, lng: 121.4830, minZoom: 11, kind: "district" },
    { text: "JING'AN",    lat: 31.2300, lng: 121.4450, minZoom: 11, kind: "district" },
    { text: "XUHUI",      lat: 31.1880, lng: 121.4380, minZoom: 11, kind: "district" },
    { text: "HONGKOU",    lat: 31.2700, lng: 121.4880, minZoom: 11, kind: "district" },
    { text: "PUDONG",     lat: 31.2320, lng: 121.5250, minZoom: 11, kind: "district" },
    { text: "CHANGNING",  lat: 31.2180, lng: 121.4090, minZoom: 13, kind: "district" },
    { text: "PUTUO",      lat: 31.2530, lng: 121.4160, minZoom: 13, kind: "district" },
    { text: "YANGPU",     lat: 31.2830, lng: 121.5180, minZoom: 13, kind: "district" },
    /* Both river labels were floating over land -- 875m and 562m from their own
       centrelines. Now snapped onto the geometry. */
    { text: "Huangpu River",   lat: 31.2476, lng: 121.4982, minZoom: 13, kind: "water" },
    { text: "Suzhou Creek",    lat: 31.2432, lng: 121.4581, minZoom: 14, kind: "water" },
    { text: "The Bund",        lat: 31.2384, lng: 121.4886, minZoom: 14, kind: "place" },
    { text: "People's Square", lat: 31.2304, lng: 121.4723, minZoom: 14, kind: "place" },
  ],
  /* "Old Town" is gone rather than corrected. All three Suzhou restaurants are
     in 姑苏区 within the historic moat, so the label named the ground its own
     pins already stood on, and at 604m it collided with Gu Su Qiao. The city
     label moved 1.3km south-west off the pin cluster; it is still inside 姑苏区
     (沧浪街道), so it has not drifted out of the old city it stands for. */
  suzhou: [
    { text: "SUZHOU",    lat: 31.2985, lng: 120.6180, minZoom: 11, kind: "district" },
  ],
  hangzhou: [
    { text: "HANGZHOU",  lat: 30.2700, lng: 120.1400, minZoom: 11, kind: "district" },
    /* Left alone deliberately: `is_in` puts it on the water already. Snapping it
       to the nearest shoreline vertex would have beached it on 三潭印月. */
    { text: "West Lake", lat: 30.2450, lng: 120.1450, minZoom: 13, kind: "water" },
  ],
  /* UNUSED since the map became one city at a time: the overview region these
     belong to is no longer loaded or shipped. Kept so that restoring the wide
     view stays a one-line change rather than a rewrite. */
  overview: [
    { text: "SHANGHAI", lat: 31.2300, lng: 121.4700, minZoom: 8, kind: "district" },
    { text: "SUZHOU",   lat: 31.2985, lng: 120.6180, minZoom: 8, kind: "district" },
    { text: "HANGZHOU", lat: 30.2700, lng: 120.1400, minZoom: 8, kind: "district" },
  ],
};

const BASEMAP_LABEL_FONT = {
  district: { font: "600 10px ui-sans-serif, system-ui, sans-serif", spacing: "0.14em", tone: "labelInk", alpha: 0.75 },
  water:    { font: "italic 11px Georgia, serif",                    spacing: "0.02em", tone: "labelMuted", alpha: 0.95 },
  place:    { font: "500 11px ui-sans-serif, system-ui, sans-serif", spacing: "0.03em", tone: "labelInk", alpha: 0.85 },
};

const BASEMAP_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors (ODbL)';


/* --- loading ------------------------------------------------------------ */

/* Regions are separate files fetched on demand: the city you open on up front,
 * the other two the first time you switch to them, and then kept. */
const BasemapData = {
  base: DATA_BASE,
  index: null,
  regions: new Map(),      // key -> parsed payload
  pending: new Map(),      // key -> in-flight promise

  loadIndex() {
    if (this.index) return Promise.resolve(this.index);
    if (!this.pending.has("__index")) {
      this.pending.set("__index", loadJSON(`${this.base}basemap.index.json`)
        .then((payload) => {
          this.index = payload.regions || [];
          return this.index;
        })
        .catch(() => {
          this.pending.delete("__index");
          return null;
        }));
    }
    return this.pending.get("__index");
  },

  spec(key) {
    return (this.index || []).find((r) => r.region === key) || null;
  },

  load(key) {
    if (this.regions.has(key)) return Promise.resolve(this.regions.get(key));
    if (this.pending.has(key)) return this.pending.get(key);

    const job = this.loadIndex()
      .then((index) => {
        const spec = index && index.find((r) => r.region === key);
        if (!spec) throw new Error(`unknown region ${key}`);
        return loadJSON(this.base + spec.file);
      })
      .then((payload) => {
        this.regions.set(key, payload);
        this.pending.delete(key);
        return payload;
      })
      .catch(() => {
        this.pending.delete(key);
        return null;
      });

    this.pending.set(key, job);
    return job;
  },
};


/* --- renderer ----------------------------------------------------------- */

const VectorBasemap = L.Layer.extend({
  initialize(options) {
    this._regions = new Map();     // key -> {rings, bounds, labels, spec}
    this._preset = BASEMAP_PRESETS[BASEMAP_SHIPPED_PRESET];
    this._theme = "light";
    this._showLabels = true;
    L.setOptions(this, options);
  },

  /* Projects once, on the way in. ~20ms for Shanghai's 22k rings. */
  addRegion(key, payload, labels, spec) {
    if (this._regions.has(key)) return;

    const rings = {};
    const bounds = {};
    for (const name of BASEMAP_LAYER_ORDER) {
      const source = (payload.layers && payload.layers[name]) || [];
      const projected = new Array(source.length);
      const boxes = new Array(source.length);
      for (let i = 0; i < source.length; i++) {
        const ring = source[i];
        const flat = new Float64Array(ring.length * 2);
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (let j = 0; j < ring.length; j++) {
          // ring is [lng, lat]; zoom 0 so a redraw is only a scale
          const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(ring[j][1], ring[j][0]), 0);
          flat[j * 2] = p.x;
          flat[j * 2 + 1] = p.y;
          if (p.x < minX) minX = p.x;
          if (p.y < minY) minY = p.y;
          if (p.x > maxX) maxX = p.x;
          if (p.y > maxY) maxY = p.y;
        }
        const closed = ring.length > 3 &&
          ring[0][0] === ring[ring.length - 1][0] &&
          ring[0][1] === ring[ring.length - 1][1];
        projected[i] = { flat, closed };
        boxes[i] = [minX, minY, maxX, maxY];
      }
      rings[name] = projected;
      bounds[name] = boxes;
    }

    const placed = (labels || []).map((label) => {
      const p = L.CRS.EPSG3857.latLngToPoint(L.latLng(label.lat, label.lng), 0);
      return Object.assign({}, label, { x: p.x, y: p.y });
    });

    this._regions.set(key, {
      rings, bounds, labels: placed,
      minZoom: (spec && spec.min_zoom) || 0,
      maxZoom: (spec && spec.max_zoom) || 24,
    });
    if (this._map) this._reset();
  },

  hasRegion(key) { return this._regions.has(key); },

  /* `visible` and `only` exist for the lab, which wants to switch a layer off
     or look at one region at a time. The map itself passes neither and gets
     everything it has loaded. */
  setStyle(preset, theme, showLabels, visible) {
    if (preset) this._preset = preset;
    if (theme) this._theme = theme;
    if (showLabels !== undefined) this._showLabels = showLabels;
    if (visible !== undefined) this._visible = visible;
    if (this._map) this._reset();
  },

  setOnlyRegions(keys) {
    this._only = keys ? new Set(keys) : null;
    if (this._map) this._reset();
  },

  onAdd(map) {
    this._map = map;
    this._canvas = L.DomUtil.create("canvas", "leaflet-layer");
    this._ctx = this._canvas.getContext("2d");
    map.getPanes().tilePane.appendChild(this._canvas);
    map.on("moveend zoomend resize", this._reset, this);
    this._reset();
  },

  onRemove(map) {
    map.off("moveend zoomend resize", this._reset, this);
    L.DomUtil.remove(this._canvas);
  },

  _reset() {
    const map = this._map;
    if (!map) return;
    const size = map.getSize();
    const dpr = window.devicePixelRatio || 1;
    L.DomUtil.setPosition(this._canvas, map.containerPointToLayerPoint([0, 0]));
    this._canvas.width = Math.round(size.x * dpr);
    this._canvas.height = Math.round(size.y * dpr);
    this._canvas.style.width = `${size.x}px`;
    this._canvas.style.height = `${size.y}px`;
    this._ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this._draw();
  },

  /* Road width in CSS pixels: base is the width at zoom 14, 1.55x per zoom.
     Keeps the hierarchy readable without the majors going slab-like at 17.

     The floor is 0.5px rather than something smaller because below about half a
     pixel a stroke stops reading as a line at all on a 1x display -- which is
     exactly what happened to the expressways in the zoom-9 day-trips view. */
  _widthAt(base, zoom) {
    return Math.max(0.5, base * Math.pow(1.55, zoom - 14));
  },

  _draw() {
    const map = this._map;
    const ctx = this._ctx;
    const preset = this._preset;
    if (!map || !preset) return;

    const size = map.getSize();
    const palette = preset[this._theme];
    const zoom = map.getZoom();
    const scale = Math.pow(2, zoom);
    const origin = map.getPixelOrigin();
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    const offX = origin.x + topLeft.x;
    const offY = origin.y + topLeft.y;

    ctx.clearRect(0, 0, size.x, size.y);
    ctx.fillStyle = palette.page;
    ctx.fillRect(0, 0, size.x, size.y);

    const pad = 40 / scale;
    const viewMinX = offX / scale - pad;
    const viewMinY = offY / scale - pad;
    const viewMaxX = (offX + size.x) / scale + pad;
    const viewMaxY = (offY + size.y) / scale + pad;

    const started = performance.now();
    let drawn = 0;
    let skipped = 0;   // culled by the viewport test; the lab reports the ratio

    // Region is the inner loop so all the water lands before any road does --
    // otherwise the coarse overview would paint over the detailed city.
    const active = [...this._regions.entries()]
      .filter(([key, r]) => (!this._only || this._only.has(key)) &&
                            zoom >= r.minZoom && zoom <= r.maxZoom)
      .map(([, r]) => r);

    for (const name of BASEMAP_LAYER_ORDER) {
      if (zoom < BASEMAP_MIN_ZOOM[name]) continue;
      if (this._visible && this._visible[name] === false) continue;
      const isRoad = name.startsWith("roads_");
      const tier = isRoad ? name.slice(6) : null;

      const fillPath = new Path2D();
      const linePath = new Path2D();
      let anyFill = false;
      let anyLine = false;

      for (const region of active) {
        const rings = region.rings[name] || [];
        const boxes = region.bounds[name] || [];
        for (let i = 0; i < rings.length; i++) {
          const b = boxes[i];
          if (b[2] < viewMinX || b[0] > viewMaxX ||
              b[3] < viewMinY || b[1] > viewMaxY) { skipped++; continue; }
          drawn++;
          const entry = rings[i];
          const polygon = entry.closed && !isRoad;
          const target = polygon ? fillPath : linePath;
          const flat = entry.flat;
          target.moveTo(flat[0] * scale - offX, flat[1] * scale - offY);
          for (let j = 2; j < flat.length; j += 2) {
            target.lineTo(flat[j] * scale - offX, flat[j + 1] * scale - offY);
          }
          if (polygon) { target.closePath(); anyFill = true; } else anyLine = true;
        }
      }

      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      if (anyFill) {
        ctx.fillStyle = name === "water" ? palette.water : palette.green;
        ctx.fill(fillPath);
      }
      if (anyLine) {
        if (isRoad) {
          const width = this._widthAt(preset.widths[tier], zoom);
          if (palette.casing && width > 1.6) {
            ctx.strokeStyle = palette.casing;
            ctx.lineWidth = width + 1.2;
            ctx.stroke(linePath);
          }
          ctx.strokeStyle = palette[tier];
          ctx.lineWidth = width;
        } else {
          ctx.strokeStyle = name === "water" ? palette.waterLine : palette.greenLine;
          ctx.lineWidth = Math.max(0.5, this._widthAt(0.9, zoom));
        }
        ctx.stroke(linePath);
      }
    }

    let labelsDrawn = 0;
    if (this._showLabels) {
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.lineJoin = "round";
      for (const region of active) {
        for (const label of region.labels) {
          if (zoom < label.minZoom) continue;
          const x = label.x * scale - offX;
          const y = label.y * scale - offY;
          if (x < -80 || y < -30 || x > size.x + 80 || y > size.y + 30) continue;

          const spec = BASEMAP_LABEL_FONT[label.kind] || BASEMAP_LABEL_FONT.place;
          ctx.font = spec.font;
          ctx.letterSpacing = spec.spacing;   // real canvas property in Chrome
          ctx.globalAlpha = spec.alpha;
          // halo first, so a label stays readable where it crosses a road
          ctx.strokeStyle = palette.labelHalo;
          ctx.lineWidth = 3;
          ctx.strokeText(label.text, x, y);
          ctx.fillStyle = palette[spec.tone];
          ctx.fillText(label.text, x, y);
          labelsDrawn++;
        }
      }
      ctx.globalAlpha = 1;
      ctx.letterSpacing = "0px";
    }

    this._stats = { ms: performance.now() - started, drawn, skipped, labelsDrawn, zoom };
    if (this.options.onDraw) {
      if (this._pending) cancelAnimationFrame(this._pending);
      this._pending = requestAnimationFrame(() => {
        this._pending = null;
        this.options.onDraw(this._stats);
      });
    }
  },
});
