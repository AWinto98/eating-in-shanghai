/* Step 3 -- the map.
 *
 * Reads data/restaurants.geo.json (step 2's output) and plots the WGS-84
 * coordinates, because the basemap is WGS-84; the GCJ-02 pair in the same
 * record is what an Amap basemap or the Amap routing API in step 4 would use.
 *
 * Pins are all one colour. With 11 categories a categorical palette stops being
 * decodable at pin size, so category is carried by the filter list instead --
 * which doubles as the legend, and never encodes identity by colour alone.
 */

const DATA_URL = DATA_BASE + "restaurants.geo.json";

/* The basemap is drawn from OpenStreetMap data by web/js/basemap.js, not
 * fetched as tiles. CARTO's are free to use but not free to bundle into a paid
 * download, and a vector basemap is an eighth the size, works with no network,
 * and can be styled to match the guide. Regions load on demand -- see
 * ensureRegions(). */

/* "The New Ones (2026)" is a time axis, not a cuisine one -- it competed with
 * Noodles and Regional while its own notes named the real cuisine. The six are
 * moved onto the cuisine axis and keep their recency as a badge instead.
 * Each target follows a precedent already in the guide: Regional is where a
 * province's cuisine done in Shanghai lives (Yunnan, Anhui, Guangxi are all
 * there), and Chai Mi Duo -- also Yunnan -- is filed exactly this way. */
const RECATEGORISE = {
  "sheng-ji": "Regional",     // Shunde congee
  "ye-shan-tong": "Regional", // "a Jiangxi chain"
  "guo-guo": "Regional",      // Guizhou rice dishes
  "in-and-out": "Regional",   // Yunnan, like Chai Mi Duo
  "xiao-tao": "Noodles",      // spring onion noodles
  "yun-he": "Noodles",        // Shanghai/Suzhou noodles
};
const NEW_IN_2026 = new Set(Object.keys(RECATEGORISE));

/* Step 1 flagged Wu You Xian `no_body_entry` -- in the directory but never
 * written about, so it has no category. It gets a named bucket rather than
 * being dropped, which would make it vanish silently whenever a filter is on. */
const NO_CATEGORY = "Uncategorised";

/* Three cities, three maps. This replaced a "day trips" toggle that widened one
 * map to hold all three at zoom 9, where they are islands 85-175km apart with
 * nothing between them.
 *
 * Separate maps match the data rather than fighting it: the walking routes were
 * precomputed **within-city only**, on the grounds that nobody walks Shanghai to
 * Hangzhou. On the combined map a walk spanning two cities had no route to draw
 * and fell through to an error in the shipped build; here it cannot be asked
 * for. Each city also loads only its own basemap, and the wide overview region
 * that only the zoom-9 view needed is no longer built into the download.
 *
 * `filters: false` says the city is too small for the filter panel to mean
 * anything -- Suzhou and Hangzhou are three places each, all of them Jiangnan,
 * and none of the six 2026 additions is outside Shanghai. */
const CITIES = [
  { key: "Shanghai", region: "shanghai", filters: true },
  { key: "Suzhou",   region: "suzhou",   filters: false },
  { key: "Hangzhou", region: "hangzhou", filters: false },
];
const HOME_CITY = "Shanghai";
const cityOf = (key) => CITIES.find((c) => c.key === key) || CITIES[0];

const SHANGHAI_PADDING = [40, 40];
const CLOSE_ENOUGH_M = 5;   // below this, two pins are the same dot
const SPREAD_M = 11;        // how far to nudge them apart

/* Fitting all 47 Shanghai pins puts Jiading (16km), Baoshan (14km) and Sanlin
 * (10.6km) at the edges and squeezes the other 44 into a blob downtown. The
 * opening view trims the extremes off each edge so the centre fills the frame;
 * the outliers stay on the map, just outside the first screen. */
const EDGE_TRIM = 0.05;
const TRIM_MIN_POINTS = 12;

const ALL_DISTRICTS = "__all__";

const state = {
  records: [],
  categories: [],
  districts: [],
  active: new Set(),
  district: ALL_DISTRICTS,
  onlyIds: null,      // when set, the map shows exactly these and nothing else
  city: HOME_CITY,
  newOnly: false,
  markers: new Map(),
  intros: {},
};

let map;
let layer;
let tileLayer;

/* --- helpers -------------------------------------------------------- */

const esc = (s) =>
  String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));

function metresApart(a, b) {
  const mid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  return Math.hypot(
    (b.lng - a.lng) * 111320 * Math.cos(mid),
    (b.lat - a.lat) * 110540
  );
}

/* Jingmei and Bastard are both at 延平路128号, so they land on one dot and the
 * upper pin is unclickable. Co-located pins get spread onto a small ring --
 * a visual nudge only; geo.wgs84 in the data is untouched. */
function spreadCollisions(records) {
  const groups = [];
  records.forEach((rec) => {
    const hit = groups.find((g) => metresApart(g[0].point, rec.point) < CLOSE_ENOUGH_M);
    if (hit) hit.push(rec);
    else groups.push([rec]);
  });

  groups.forEach((group) => {
    if (group.length < 2) return;
    const latOffset = SPREAD_M / 110540;
    const lngOffset = SPREAD_M / (111320 * Math.cos(group[0].point.lat * (Math.PI / 180)));
    group.forEach((rec, i) => {
      const angle = (2 * Math.PI * i) / group.length;
      rec.point = {
        lat: rec.point.lat + Math.sin(angle) * latOffset,
        lng: rec.point.lng + Math.cos(angle) * lngOffset,
      };
      rec.colocatedWith = group.filter((o) => o !== rec).map((o) => o.name_en);
    });
  });
}

function categoryOf(rec) {
  return RECATEGORISE[rec.id] || rec.category || NO_CATEGORY;
}

/* Bounds with the outermost points trimmed off each edge, so a handful of
 * distant places cannot dictate the zoom. Trimming is skipped for small
 * selections -- which now covers Suzhou and Hangzhou at three pins each, where
 * dropping the outermost 5% would mean dropping a place from view. */
function viewBounds(points) {
  if (!points.length) return null;
  const trim =
    points.length < TRIM_MIN_POINTS ? 0 : Math.floor(points.length * EDGE_TRIM);
  if (!trim) return L.latLngBounds(points);

  const lats = points.map((p) => p.lat).sort((a, b) => a - b);
  const lngs = points.map((p) => p.lng).sort((a, b) => a - b);
  const cut = (arr) => arr.slice(trim, arr.length - trim);
  const [lat, lng] = [cut(lats), cut(lngs)];
  return L.latLngBounds(
    [lat[0], lng[0]],
    [lat[lat.length - 1], lng[lng.length - 1]]
  );
}

function fitTo(points) {
  const bounds = viewBounds(points);
  if (!bounds) return;
  // Leaflet's zoom animation silently drops large jumps -- turning day trips on
  // is a 13 -> 9 change, and the animated path leaves the map where it was. Only
  // animate the short hops; jump the long ones.
  const target = map.getBoundsZoom(bounds, false, L.point(SHANGHAI_PADDING));
  map.fitBounds(bounds, {
    padding: SHANGHAI_PADDING,
    maxZoom: 16,
    animate: Math.abs(target - map.getZoom()) <= 2,
  });
}

/* --- popup ---------------------------------------------------------- */

/* The descriptions are the author's writing. Both editions now quote each entry
 * whole, on his own instruction -- see TEXT in config.js for the reasoning.
 *
 * The extract path below is kept working rather than deleted: it cuts on whole
 * sentences, never mid-word, and reinstating it is one line in config.js. How
 * much of his prose ships is the decision most likely to move, and it should
 * never mean editing this file.
 */
const TEASER_MIN = TEXT.min;
const TEASER_MAX = TEXT.max;

function teaser(notes) {
  const text = (notes || "").trim();
  if (!text) return { text: "", truncated: false };

  // The buyer edition quotes the entry whole: they have paid for the words.
  if (TEXT.mode === "full") return { text, truncated: false };

  // Collect sentence-END positions rather than matching whole sentences: a
  // pattern for the latter silently skips text it cannot parse, and "(R.I.P)"
  // reduced one entry to the three characters "P).".
  const ends = [];
  const boundary = /[.!?]+(?=\s|$)/g;
  let match;
  while ((match = boundary.exec(text)) !== null) {
    ends.push(match.index + match[0].length);
  }
  if (!ends.length || ends[ends.length - 1] < text.length) ends.push(text.length);

  let cut = ends.find((end) => end >= TEASER_MIN);
  if (cut === undefined) cut = ends[ends.length - 1];

  if (cut > TEASER_MAX) {
    let clipped = text.slice(0, TEASER_MAX);
    clipped = clipped.slice(0, Math.max(clipped.lastIndexOf(" "), 0)).trim();
    return { text: `${clipped}…`, truncated: true };
  }
  const out = text.slice(0, cut).trim();
  return { text: out, truncated: out.length < text.length };
}

function popupHtml(rec) {
  const parts = [`<div class="pop">`];
  parts.push(`<h2 class="pop-name">${esc(rec.name_en || rec.name_cn)}</h2>`);
  if (rec.name_cn) parts.push(`<p class="pop-cn">${esc(rec.name_cn)}</p>`);

  parts.push(`<p class="pop-meta">`);
  parts.push(`<span class="tag">${esc(categoryOf(rec))}</span>`);
  if (NEW_IN_2026.has(rec.id)) parts.push(`<span class="tag">New in 2026</span>`);
  const where = rec.city === "Shanghai" ? rec.geo.district : `${rec.city} · ${rec.geo.district}`;
  if (where) parts.push(`<span class="tag plain">${esc(where)}</span>`);
  parts.push(`</p>`);

  const extract = teaser(rec.notes);
  if (extract.text) {
    parts.push(`<p class="pop-notes">${esc(extract.text)}</p>`);
    // The credit rides with the words, because a screenshot of this card
    // travels without the landing page attached.
    parts.push(
      `<p class="pop-credit">${extract.truncated ? "Extract from" : "From"} ` +
      `<em>${esc(GUIDE.title)}</em> by ${esc(GUIDE.author)}` +
      (extract.truncated
        ? ` &middot; ${GUIDE.url
            ? `<a href="${esc(GUIDE.url)}" target="_blank" rel="noopener noreferrer">full entry in the guide &rarr;</a>`
            : "full entry in the guide"}`
        : "") +
      `</p>`
    );
  }

  parts.push(`<p class="pop-addr">`);
  if (rec.address_cn) parts.push(`<span>${esc(rec.address_cn)}</span>`);
  if (rec.address_en) parts.push(`<span>${esc(rec.address_en)}</span>`);
  parts.push(`</p>`);

  parts.push(
    `<p class="pop-actions">` +
    `<button type="button" class="btn add-walk" data-add-walk="${esc(rec.id)}">` +
    `Add to walk</button>`
  );
  if (rec.dianping_url) {
    parts.push(
      `<a class="pop-link" href="${esc(rec.dianping_url)}" target="_blank" ` +
      `rel="noopener noreferrer">Dianping &rarr;</a>`
    );
  }
  parts.push(`</p>`);

  // Where step 2 could not pin an exact door, the popup says so rather than
  // letting the pin imply a precision it does not have.
  const flags = rec.geo.flags || [];
  const caveats = [];
  if (flags.includes("chain_top_branch")) {
    caveats.push("A chain with too many branches to list — this is one of them.");
  }
  if (flags.includes("resolved_by_name")) {
    caveats.push("Located by name; the guide's address matched the wrong street.");
  }
  if (flags.includes("coarse_precision")) {
    caveats.push("Approximate — this one resolved to the street, not the door.");
  }
  if (rec.colocatedWith && rec.colocatedWith.length) {
    caveats.push(`Same address as ${rec.colocatedWith.map(esc).join(", ")}.`);
  }
  if (caveats.length) parts.push(`<p class="pop-flag">${caveats.join(" ")}</p>`);

  parts.push(`</div>`);
  return parts.join("");
}

/* --- filtering ------------------------------------------------------ */

function visible(rec) {
  // Focusing on a walk overrides the filters rather than intersecting with
  // them -- otherwise a stop could be filtered out of the very walk you asked
  // to look at. The panel dims the filters to show they are not applying.
  if (state.onlyIds) return state.onlyIds.has(rec.id);

  if (rec.city !== state.city) return false;

  // The small cities show every place they have: their filter controls are
  // hidden, so leaving a stale filter applying would hide pins with nothing
  // on screen to explain why.
  if (!cityOf(state.city).filters) return true;

  if (!state.active.has(categoryOf(rec))) return false;
  if (state.newOnly && !NEW_IN_2026.has(rec.id)) return false;
  if (state.district !== ALL_DISTRICTS && rec.geo.district !== state.district) {
    return false;
  }
  return true;
}

function render({ fit = false } = {}) {
  const shown = state.records.filter(visible);

  layer.clearLayers();
  shown.forEach((rec) => layer.addLayer(state.markers.get(rec.id)));

  document.getElementById("shown").textContent = shown.length;
  document.getElementById("shown-label").textContent =
    shown.length === 1 ? "place shown" : "places shown";

  // Counts reflect the other filters, so a category reading 0 explains itself.
  const contextual = state.onlyIds
    ? state.records.filter((rec) => state.onlyIds.has(rec.id))
    : state.records.filter(
        (rec) =>
          rec.city === state.city &&
          (!state.newOnly || NEW_IN_2026.has(rec.id)) &&
          (state.district === ALL_DISTRICTS || rec.geo.district === state.district)
      );
  state.categories.forEach(({ name }) => {
    const n = contextual.filter((rec) => categoryOf(rec) === name).length;
    const li = document.querySelector(`li[data-cat="${CSS.escape(name)}"]`);
    li.querySelector(".cat-count").textContent = n;
    li.classList.toggle("empty", n === 0);
    li.classList.toggle("off", !state.active.has(name));
  });

  // While focused on a walk the filters do nothing, so say so by dimming them
  // and taking them out of the tab order rather than leaving dead controls.
  const focused = Boolean(state.onlyIds);
  document.getElementById("panel").classList.toggle("walk-focus", focused);
  ["filters", "district-section", "toggles"].forEach((id) => {
    const section = document.getElementById(id);
    if (section) section.inert = focused;
  });

  updateIntro();
  updateEmptyNote(shown.length);
  document.dispatchEvent(new CustomEvent("map:rendered"));

  if (fit && shown.length) fitTo(shown.map((r) => r.point));
}

/* The guide opens each cuisine section with a paragraph. When exactly one
 * category is showing there is room to give it back -- including the Jiangnan
 * one, kept verbatim, since that is where the author says the last three places
 * are tour-only and have no addresses. */
function updateIntro() {
  const box = document.getElementById("intro");
  if (state.onlyIds) {          // the category filters are not applying
    box.hidden = true;
    return;
  }
  // In a city without filters there is nothing to solo, so the intro follows
  // the one category its places actually belong to -- which for both Suzhou
  // and Hangzhou is Jiangnan, the section that says the last three places are
  // tour-only and have no addresses.
  let only;
  if (!cityOf(state.city).filters) {
    const present = new Set(
      state.records.filter((r) => r.city === state.city).map(categoryOf)
    );
    only = present.size === 1 ? [...present][0] : null;
  } else {
    only = state.active.size === 1 ? [...state.active][0] : null;
  }
  const text = only && state.intros[only];
  if (!text) {
    box.hidden = true;
    return;
  }
  document.getElementById("intro-title").textContent = only;
  document.getElementById("intro-text").textContent = text;
  box.hidden = false;
}

function updateEmptyNote(count) {
  const existing = document.querySelector(".empty-note");
  if (count > 0) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;
  const note = document.createElement("div");
  note.className = "empty-note";
  note.textContent = "Nothing matches these filters.";
  document.querySelector(".map-wrap").appendChild(note);
}

/* --- build ---------------------------------------------------------- */

function buildFilters() {
  const list = document.getElementById("categories");
  list.innerHTML = "";

  state.categories.forEach(({ name }) => {
    const li = document.createElement("li");
    li.dataset.cat = name;
    li.innerHTML =
      `<label><input type="checkbox" checked>` +
      `<span class="cat-name">${esc(name)}</span>` +
      `<span class="cat-count"></span></label>`;
    li.querySelector("input").addEventListener("change", (e) => {
      if (e.target.checked) state.active.add(name);
      else state.active.delete(name);
      render();
    });
    list.appendChild(li);
  });

  // District comes only from geocoding -- the guide has none. A single select
  // rather than checkboxes: 13 districts, and 9 of them hold one place each.
  const select = document.getElementById("district-select");
  select.innerHTML = "";
  const all = document.createElement("option");
  all.value = ALL_DISTRICTS;
  // Scoped to the city that has filters at all: the count under "All" has to
  // match the map, and the other two cities' districts would never be reachable
  // from this dropdown anyway.
  all.textContent = `All districts (${
    state.records.filter((r) => r.city === HOME_CITY).length})`;
  select.appendChild(all);
  state.districts.forEach(({ name, total }) => {
    const option = document.createElement("option");
    option.value = name;
    option.textContent = `${name} (${total})`;
    select.appendChild(option);
  });
  select.addEventListener("change", (e) => {
    state.district = e.target.value;
    // Picking a district is asking to go there, so the map follows.
    render({ fit: true });
  });

  document.getElementById("newonly").addEventListener("change", (e) => {
    state.newOnly = e.target.checked;
    render({ fit: true });
  });

  // Reset clears the filters, not the city. Switching city is navigation.
  document.getElementById("reset").addEventListener("click", () => {
    state.active = new Set(state.categories.map((c) => c.name));
    state.newOnly = false;
    state.district = ALL_DISTRICTS;
    document.querySelectorAll('.cat-list input').forEach((i) => (i.checked = true));
    document.getElementById("newonly").checked = false;
    select.value = ALL_DISTRICTS;
    render({ fit: true });
  });
}

/* --- cities --------------------------------------------------------- */

function buildCities() {
  const nav = document.getElementById("cities");
  nav.innerHTML = "";
  CITIES.forEach((city) => {
    const n = state.records.filter((r) => r.city === city.key).length;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "city-btn";
    button.dataset.city = city.key;
    button.setAttribute("aria-pressed", String(city.key === state.city));
    button.innerHTML =
      `<span class="city-name">${esc(city.key)}</span>` +
      `<span class="city-count">${n}</span>`;
    button.addEventListener("click", () => setCity(city.key));
    nav.appendChild(button);
  });
}

function setCity(key) {
  if (key === state.city) return;
  const previous = state.city;
  state.city = key;

  document.querySelectorAll(".city-btn").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.city === key));
  });

  // A filter set in Shanghai must not survive into a city whose filter panel
  // is hidden, or into the trip back.
  state.active = new Set(state.categories.map((c) => c.name));
  state.newOnly = false;
  state.district = ALL_DISTRICTS;
  document.querySelectorAll(".cat-list input").forEach((i) => (i.checked = true));
  document.getElementById("newonly").checked = false;
  document.getElementById("district-select").value = ALL_DISTRICTS;

  applyCityMode();
  ensureRegions();

  // walk.js keeps one walk per city and swaps them here. It also owns
  // state.onlyIds through setOnly(), so it has to move before the render.
  document.dispatchEvent(new CustomEvent("map:citychange", {
    detail: { city: key, previous },
  }));

  render({ fit: true });
}

/* Shanghai gets the filters. The other two get the guide's words and a list,
 * because three places in one category cannot be filtered into anything. */
function applyCityMode() {
  const city = cityOf(state.city);
  ["filters", "district-section", "toggles"].forEach((id) => {
    const section = document.getElementById(id);
    if (section) section.hidden = !city.filters;
  });
  document.getElementById("places").hidden = city.filters;
  if (!city.filters) buildPlacesList();
}

function buildPlacesList() {
  const list = document.getElementById("places-list");
  list.innerHTML = "";
  state.records
    .filter((rec) => rec.city === state.city)
    .forEach((rec) => {
      const li = document.createElement("li");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "place-btn";
      button.innerHTML =
        `<span class="place-name">${esc(rec.name_en || rec.name_cn)}</span>` +
        `<span class="place-where">${esc(rec.geo.district || "")}</span>`;
      // Same gesture as clicking the pin, so the list and the map agree.
      button.addEventListener("click", () => {
        const marker = state.markers.get(rec.id);
        if (!marker) return;
        map.setView(marker.getLatLng(), Math.max(map.getZoom(), 15));
        marker.openPopup();
      });
      li.appendChild(button);
      list.appendChild(li);
    });
}

/* Collapsing the panel changes the map container's size. Leaflet caches that
 * size, so without invalidateSize() the tiles keep the old width and the pins
 * sit off-centre -- and because the panel animates, it has to be called when
 * the transition ends, not when the class flips. */
function buildPanelToggle() {
  const app = document.getElementById("app");
  const panel = document.getElementById("panel");
  const button = document.getElementById("toggle-panel");

  // Collapsing the panel widens the map, which raises the zoom needed to cover
  // the region -- so the floor is re-measured on the same beat as the size.
  const settle = () => {
    map.invalidateSize({ animate: false });
    fenceToRegion();
  };
  app.addEventListener("transitionend", (e) => {
    if (e.target === app) settle();
  });

  button.addEventListener("click", () => {
    const collapsed = app.classList.toggle("collapsed");
    button.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "Show the filters" : "Hide the filters";
    button.title = label;
    button.querySelector(".sr-only").textContent = label;
    panel.inert = collapsed;
    // Belt and braces: if the transition is skipped (reduced motion, or the
    // tab is hidden) transitionend never fires.
    setTimeout(settle, 260);
  });
}

/* A seal -- a vermilion name-chop. Symmetric, so unlike the teardrop it has no
 * tip: the address is the centre of the mark, and iconAnchor is its middle. */
const PIN_SIZE = [17, 17];
const PIN_SVG =
  '<svg viewBox="0 0 18 18" aria-hidden="true" focusable="false">' +
  '<rect class="pin-body" x="1.6" y="1.6" width="14.8" height="14.8" rx="2.6"/>' +
  '<path class="pin-mark" d="M9 4.8v8.4M4.8 9h8.4"/></svg>';

function buildMarkers() {
  state.records.forEach((rec) => {
    const marker = L.marker(rec.point, {
      icon: L.divIcon({
        html: PIN_SVG,
        className: "pin",
        iconSize: PIN_SIZE,
        iconAnchor: [PIN_SIZE[0] / 2, PIN_SIZE[1] / 2],
        popupAnchor: [0, -PIN_SIZE[1] / 2 - 2],
        tooltipAnchor: [0, -PIN_SIZE[1] / 2 - 1],
      }),
      title: "",            // the bound tooltip does this; suppress the native one
      riseOnHover: true,
      alt: rec.name_en || rec.name_cn,
    });
    marker.bindTooltip(rec.name_en || rec.name_cn, {
      direction: "top",
      className: "pin-tip",
    });
    marker.bindPopup(popupHtml(rec), { maxWidth: 300, autoPanPadding: [24, 24] });
    state.markers.set(rec.id, marker);
  });
}

/* Light by design; the toggle is the only way to dark, and the choice sticks. */
function buildThemeToggle() {
  const button = document.getElementById("toggle-theme");
  const stored = (() => {
    try {
      return localStorage.getItem("theme");
    } catch (err) {
      return null;   // private mode / blocked storage
    }
  })();

  const apply = (dark) => {
    if (dark) document.documentElement.dataset.theme = "dark";
    else delete document.documentElement.dataset.theme;
    button.setAttribute("aria-pressed", String(dark));
    const label = dark ? "Switch to light" : "Switch to dark";
    button.title = label;
    button.querySelector(".sr-only").textContent = label;
  };

  apply(stored === "dark");

  button.addEventListener("click", () => {
    const dark = document.documentElement.dataset.theme !== "dark";
    apply(dark);
    try {
      localStorage.setItem("theme", dark ? "dark" : "light");
    } catch (err) {
      /* not persisting is survivable */
    }
  });
}

/* The page is light by design -- the guide leans on white space -- so the theme
   comes from an explicit stamp, not from prefers-color-scheme. */
function applyTiles() {
  const dark = document.documentElement.dataset.theme === "dark";
  if (!tileLayer) {
    tileLayer = new VectorBasemap({});
    tileLayer.addTo(map);
    map.attributionControl.addAttribution(BASEMAP_ATTRIBUTION);
  }
  tileLayer.setStyle(BASEMAP_PRESETS[BASEMAP_SHIPPED_PRESET],
                     dark ? "dark" : "light");
  // The canvas paints its own ground, but the container shows through before
  // the first draw and outside the drawn area.
  const container = map.getContainer();
  container.style.background =
    BASEMAP_PRESETS[BASEMAP_SHIPPED_PRESET][dark ? "dark" : "light"].page;
  // Pins need no re-inking: their SVG reads the CSS tokens directly.
}

/* One region: the city being looked at. Shanghai loads at startup; the other
 * two arrive the first time they are opened and are kept, so going back is
 * instant.
 *
 * The wide "overview" region is deliberately not loaded and no longer shipped.
 * It existed only to fill the gap in the old all-three-cities view at zoom 9,
 * where the detailed boxes were islands with nothing between them. With one
 * city on screen at a time there is no gap, and it was 977 KB. */
/* The map may not show ground that was never built.
 *
 * minZoom was 11 because that is where the city regions start being drawn --
 * but "from which zoom is this region drawn?" and "from which zoom does it
 * fill the screen?" are different questions, and only the second one keeps the
 * viewport full. Shanghai's box is 0.30 x 0.27 deg, which covers a 1920px
 * window only from z13.3; at z11 you were looking at about five times more
 * width than there was data for, and the surplus painted as bare page colour.
 * Suzhou was the worst of the three -- its box needs z15.0 and it was allowed
 * down to 11.
 *
 * So the floor is measured rather than declared, per city and per viewport,
 * and maxBounds stops the same journey sideways. Nothing is lost by either:
 * all 53 pins sit inside their own region's box, so everything the guide
 * contains is still reachable. */
function fenceToRegion() {
  if (!map) return;
  const spec = BasemapData.spec(cityOf(state.city).region);
  if (!spec || !spec.bbox) return;      // index not in yet; a later call gets it

  const [south, west, north, east] = spec.bbox;
  const bounds = L.latLngBounds([south, west], [north, east]);

  /* Measured by hand rather than with getBoundsZoom(bounds, true), which snaps
   * its answer up to a whole zoom level. Shanghai's box covers a 1600px map
   * from z13.02, which snaps to 14 -- but fitting the 47 pins needs 13.50, so
   * a snapped floor would sit *above* the opening view and push the outermost
   * pins off screen. The box is only 1.47x the pin spread, close enough for
   * the rounding to invert the two. Leaflet clamps to a fractional minZoom
   * correctly, so the exact number is both safe and tighter. */
  const cover = zoomForBounds(bounds, "cover", 0);

  /* Hangzhou needs the second clamp, and it is not obvious why: covering its
   * box takes z14.08 while showing its three pins takes z13.99, so fencing to
   * the box alone would zoom past one of them. Its box is wide relative to the
   * map while its pins are tall, so "cover" is decided by width and "fit" by
   * height, and nothing stops them crossing. Shanghai and Suzhou have room to
   * spare; Hangzhou pays for it with a thin band of white at the very edge of
   * the zoom range. A restaurant you cannot see is a worse bug than that. */
  const pins = viewBounds(
    state.records.filter((rec) => rec.city === state.city).map((r) => r.point)
  );
  const fit = pins ? zoomForBounds(pins, "fit", SHANGHAI_PADDING[0]) : null;

  if (cover === null) return;
  let floor = fit === null ? cover : Math.min(cover, fit);
  floor = Math.min(floor, map.getMaxZoom());

  map.setMaxBounds(bounds);
  map.setMinZoom(floor);   // Leaflet zooms in by itself if the view is below it
}

/* The zoom at which `bounds` exactly covers the map container, or exactly fits
 * inside it with `pad` px to spare. Projecting at zoom 0 and scaling is all
 * this is: the bounds are boxPx * 2^z across at zoom z. */
function zoomForBounds(bounds, mode, pad) {
  const size = map.getSize();
  const nw = map.project(bounds.getNorthWest(), 0);
  const se = map.project(bounds.getSouthEast(), 0);
  const w = Math.abs(se.x - nw.x);
  const h = Math.abs(se.y - nw.y);
  if (!w || !h || !size.x || !size.y) return null;

  const sx = (size.x - 2 * pad) / w;
  const sy = (size.y - 2 * pad) / h;
  if (sx <= 0 || sy <= 0) return null;
  return Math.log2(mode === "cover" ? Math.max(sx, sy) : Math.min(sx, sy));
}

function ensureRegions() {
  if (!tileLayer) return;
  const key = cityOf(state.city).region;
  // Runs before the early return as well: switching back to a city already in
  // memory still has to re-fence, since the box differs per city.
  fenceToRegion();
  if (tileLayer.hasRegion(key)) return;
  BasemapData.load(key).then((payload) => {
    if (!payload || tileLayer.hasRegion(key)) return;
    tileLayer.addRegion(key, payload, BASEMAP_LABELS[key],
                        BasemapData.spec(key));
    fenceToRegion();       // first time through, the index arrives with this
  });
}

async function init() {
  let payload;
  try {
    payload = await loadJSON(DATA_URL);
  } catch (err) {
    showLoadError(err);
    return;
  }

  state.intros = payload.section_intros || {};
  state.records = payload.restaurants
    .filter((rec) => rec.geo && rec.geo.wgs84)
    .map((rec) => ({
      ...rec,
      point: { lat: rec.geo.wgs84.lat, lng: rec.geo.wgs84.lng },
    }));

  spreadCollisions(state.records);

  const counts = new Map();
  state.records.forEach((rec) => {
    const name = categoryOf(rec);
    counts.set(name, (counts.get(name) || 0) + 1);
  });
  const byDistrict = new Map();
  state.records.forEach((rec) => {
    const name = rec.geo.district;
    if (name) byDistrict.set(name, (byDistrict.get(name) || 0) + 1);
  });
  state.districts = [...byDistrict.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));

  state.categories = [...counts.entries()]
    .map(([name, total]) => ({ name, total }))
    // Alphabetical, with the catch-all bucket last so it reads as the leftover.
    .sort((a, b) =>
      a.name === NO_CATEGORY ? 1 : b.name === NO_CATEGORY ? -1
        : a.name.localeCompare(b.name)
    );
  state.active = new Set(state.categories.map((c) => c.name));

  // maxZoom used to come from the tile layer; the vector basemap has no
  // inherent limit, so the map states its own.
  //
  // minZoom here is only a starting value -- fenceToRegion() replaces it with a
  // floor measured against the current city's box and the current viewport, and
  // pins maxBounds to the same box. 11 was this number for a while and was too
  // low for every city at every size; see fenceToRegion().
  /* scrollWheelZoom is "center" rather than true because the wheel is normally
   * anchored to the pointer: zooming out about the cursor pushes the centre
   * away from it, and maxBounds then drags the centre back. Near the floor the
   * viewport is almost exactly the size of the region box, so that correction
   * has to happen on *every* wheel-out, and it shows as the map jumping
   * sideways -- leftwards whenever the cursor is right of centre, which is
   * most of the time. Zooming about the centre never moves it, so there is
   * nothing for the fence to correct. Dragging still pans freely inside the
   * box, and pinch-zoom on a phone is untouched. */
  /* zoomSnap is 0 because the floor is no longer a whole number. Leaflet's
   * _limitZoom() rounds a target onto the zoomSnap grid *before* clamping it
   * to minZoom, so with the default snap of 1 every wheel target became an
   * integer while the floor sat at something like z13.02 -- the last notch
   * then moved a hundredth of a level, or nothing at all, and the wheel and
   * the zoom buttons disagreed about how far out you could go. Snapping off
   * makes fractional zoom first-class, which is what the fence requires.
   * Pinch-zoom has always produced fractional zooms, so the renderer has been
   * on this path from the start; only the wheel is new to it. */
  map = L.map("map", {
    zoomControl: true, scrollWheelZoom: "center", minZoom: 11, maxZoom: 18,
    zoomSnap: 0,
    maxBoundsViscosity: 1.0,   // a hard edge, not a rubber band
  });
  layer = L.layerGroup().addTo(map);

  buildMarkers();
  buildCities();
  buildFilters();
  buildPanelToggle();
  buildThemeToggle();   // stamps the stored theme before the palette is picked
  applyTiles();
  applyCityMode();
  ensureRegions();

  // Only fires if something stamps data-theme; the OS setting is ignored.
  new MutationObserver(applyTiles).observe(document.documentElement, {
    attributeFilter: ["data-theme"],
  });

  // The floor is a function of the viewport, so it has to be re-measured when
  // the viewport changes -- a resized window, or a phone turned on its side.
  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(fenceToRegion, 150);
  });

  // Open on Shanghai: 47 of the 53 places, and the only city with filters.
  fitTo(
    state.records.filter((rec) => rec.city === state.city).map((r) => r.point)
  );

  render();

  const flagged = state.records.filter((r) => (r.geo.flags || []).length).length;
  document.getElementById("status").innerHTML =
    `${state.records.length} places geocoded &middot; ${flagged} approximate`;

  // The narrow surface walk.js is allowed to touch. Anything it needs goes
  // through here, so the two files stay separable.
  window.FoodMap = {
    map,
    /* The city currently on screen. walk.js keeps one walk per city, because
       the route table only covers within-city pairs. */
    city: () => state.city,
    isVisible: (id) => {
      const rec = state.records.find((r) => r.id === id);
      return Boolean(rec && visible(rec));
    },
    record: (id) => state.records.find((r) => r.id === id) || null,
    marker: (id) => state.markers.get(id) || null,
    categoryOf,
    /* Restrict the map to exactly these ids, or pass null to release it. */
    setOnly: (ids, { fit = false } = {}) => {
      const next = ids && ids.length ? new Set(ids) : null;
      const unchanged =
        (!next && !state.onlyIds) ||
        (next && state.onlyIds &&
          next.size === state.onlyIds.size &&
          [...next].every((id) => state.onlyIds.has(id)));
      if (unchanged && !fit) return;   // adding a stop should not redraw twice
      state.onlyIds = next;
      render({ fit });
    },
  };
  document.dispatchEvent(new CustomEvent("map:ready"));
}

function showLoadError(err) {
  document.querySelector(".map-wrap").innerHTML =
    `<div class="load-error">` +
    `<p><strong>Could not load ${esc(DATA_URL)}</strong> (${esc(err.message)}).</p>` +
    `<p>Opening this file directly with <code>file://</code> will not work — the ` +
    `browser blocks the data fetch. Serve the project folder instead:</p>` +
    `<p><code>python -m http.server 8000</code></p>` +
    `<p>then open <code>http://localhost:8000/web/</code>.</p>` +
    `</div>`;
  document.getElementById("status").textContent = "Failed to load data.";
}

init();
