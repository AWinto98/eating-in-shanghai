/* Step 4 -- planning a walk.
 *
 * You pick the stops yourself (Add to walk, from any popup) and then either
 * take the order you chose or ask for the best one. There is no route "mode":
 * the itinerary panel simply appears once there is something in it.
 *
 * Routes come from `data/routes.json` -- every within-city pair, fetched once
 * by routes/backfill_routes.py and shipped with the map. Nothing here needs the
 * Amap key, a proxy, or a network. Amap's v3 walking endpoint takes one origin
 * and one destination -- no waypoints -- so an N-stop walk is still N-1 legs,
 * but they are now lookups rather than requests.
 *
 * /api/walking survives as a fallback for development and for any pair the
 * backfill did not cover (today: none -- all 2,174 resolved). If the table is
 * missing entirely, the map still works exactly as it did before.
 *
 * "Best order" now uses real walking distance. It used straight-line distance
 * because ordering N stops properly needs the distance between every pair, and
 * that meant N*(N-1)/2 route calls just to decide. The backfill has already
 * paid that cost for every pair in the city, so the exact answer is free.
 */

const ROUTES_URL = DATA_BASE + "routes.json";
const WALK_API = "/api/walking";        // dev fallback, see above
const MAX_STOPS = 12;

let routeTable = null;      // "fromId|toId" -> {d, t, p}
let routeTableLoad = null;  // in-flight fetch, so N legs share one request

/* Loaded on first use rather than at startup: it is a couple of megabytes and
 * most visitors never plan a walk. Resolves to null if unavailable, so every
 * caller can carry on with the proxy or with straight lines. */
function loadRoutes() {
  if (routeTable) return Promise.resolve(routeTable);
  if (!routeTableLoad) {
    routeTableLoad = loadJSON(ROUTES_URL)
      .then((payload) => {
        routeTable = payload.routes || {};
        return routeTable;
      })
      .catch(() => {
        routeTableLoad = null;   // let a later attempt retry
        return null;
      });
  }
  return routeTableLoad;
}

const walk = {
  stops: [],        // restaurant ids, in visiting order
  legs: [],         // {distance_m, duration_s, path} per consecutive pair
  layer: null,
  token: 0,         // guards against a slow fetch landing after a newer one
  only: false,      // hide everywhere that is not on the walk
};

const $ = (id) => document.getElementById(id);

/* --- geometry -------------------------------------------------------- */

function metresBetween(a, b) {
  const mid = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  return Math.hypot(
    (b.lng - a.lng) * 111320 * Math.cos(mid),
    (b.lat - a.lat) * 110540
  );
}

/* Distance between two stops, for ordering only. Real walking distance when the
 * table has the pair, which after the backfill is every within-city pair, and
 * straight line otherwise. Ordering is directional: A->B and B->A genuinely
 * differ where a river crossing is involved. */
function stopDistance(fromId, toId) {
  const hit = routeTable && routeTable[`${fromId}|${toId}`];
  if (hit) return hit.d;
  const from = window.FoodMap.record(fromId);
  const to = window.FoodMap.record(toId);
  return from && to ? metresBetween(from.point, to.point) : Infinity;
}

function pathLength(order, ids) {
  let total = 0;
  for (let i = 0; i < order.length - 1; i += 1) {
    total += stopDistance(ids[order[i]], ids[order[i + 1]]);
  }
  return total;
}

/* An open path, not a loop -- a walk ends at the last restaurant rather than
 * returning to the first. Nearest-neighbour from every possible start, then
 * 2-opt on the best of those. Exact enough well past the 12 stops allowed. */
function bestOrder(ids) {
  const n = ids.length;
  if (n < 3) return ids.map((_, i) => i);

  let best = null;
  let bestLength = Infinity;

  for (let start = 0; start < n; start += 1) {
    const order = [start];
    const unused = new Set(ids.map((_, i) => i));
    unused.delete(start);
    while (unused.size) {
      const from = order[order.length - 1];
      let nearest = null;
      let nearestDistance = Infinity;
      unused.forEach((i) => {
        const d = stopDistance(ids[from], ids[i]);
        if (d < nearestDistance) {
          nearestDistance = d;
          nearest = i;
        }
      });
      order.push(nearest);
      unused.delete(nearest);
    }
    const length = pathLength(order, ids);
    if (length < bestLength) {
      bestLength = length;
      best = order;
    }
  }

  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 0; i < best.length - 1; i += 1) {
      for (let k = i + 1; k < best.length; k += 1) {
        const candidate = best
          .slice(0, i)
          .concat(best.slice(i, k + 1).reverse(), best.slice(k + 1));
        const length = pathLength(candidate, ids);
        if (length < bestLength - 0.5) {
          best = candidate;
          bestLength = length;
          improved = true;
        }
      }
    }
  }
  return best;
}

/* --- routing --------------------------------------------------------- */

const gcj = (rec) => `${rec.geo.gcj02.lng},${rec.geo.gcj02.lat}`;

async function fetchLeg(from, to) {
  const table = await loadRoutes();
  const hit = table && table[`${from.id}|${to.id}`];
  if (hit) {
    // stored compactly: d/t/p rather than the long names, 2,174 times over
    return { distance_m: hit.d, duration_s: hit.t, path: hit.p };
  }

  const url = `${WALK_API}?origin=${encodeURIComponent(gcj(from))}` +
    `&destination=${encodeURIComponent(gcj(to))}`;
  const resp = await fetch(url);
  const payload = await resp.json().catch(() => ({}));
  if (!resp.ok || payload.error) {
    throw new Error(payload.error || `${resp.status} ${resp.statusText}`);
  }
  return payload;
}

async function routeAll() {
  const token = (walk.token += 1);
  walk.legs = [];

  if (walk.stops.length < 2) {
    drawRoute();
    renderList();
    return;
  }

  setSummary("Finding the way…", true);
  const records = walk.stops.map((id) => window.FoodMap.record(id));

  try {
    for (let i = 0; i < records.length - 1; i += 1) {
      const leg = await fetchLeg(records[i], records[i + 1]);
      if (token !== walk.token) return;   // the itinerary changed underneath us
      walk.legs.push(leg);
      drawRoute();
      renderList();
    }
  } catch (err) {
    if (token !== walk.token) return;
    // Only reachable if the precomputed table is missing *and* the proxy is
    // not answering -- normally one of the two covers every pair.
    setSummary(
      `Could not work out the route (${err.message}). ` +
      `data/routes.json is missing, and serve.py is not answering either.`,
      false,
      true
    );
    return;
  }
  renderList();
}

/* --- drawing --------------------------------------------------------- */

function drawRoute() {
  const map = window.FoodMap.map;
  if (!walk.layer) walk.layer = L.layerGroup().addTo(map);
  walk.layer.clearLayers();

  const points = walk.legs.flatMap((leg) => leg.path);
  if (points.length < 2) return;

  // Two strokes: a wide surface-coloured casing so the line stays readable over
  // dark tiles and busy streets, then the accent on top.
  L.polyline(points, {
    color: token("--pin-ring"),
    weight: 7,
    opacity: 0.9,
    lineJoin: "round",
  }).addTo(walk.layer);
  L.polyline(points, {
    color: token("--accent"),
    weight: 3,
    opacity: 1,
    lineJoin: "round",
  }).addTo(walk.layer);
}

function token(name) {
  return getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
}

/* --- panel ----------------------------------------------------------- */

function fmtDistance(m) {
  return m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`;
}

function fmtDuration(s) {
  const mins = Math.round(s / 60);
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)} h ${String(mins % 60).padStart(2, "0")}`;
}

function setSummary(text, busy = false, error = false) {
  const el = $("walk-summary");
  el.textContent = text;
  el.classList.toggle("busy", busy);
  el.classList.toggle("error", error);
}

function renderList() {
  const section = $("walk");
  const list = $("walk-list");

  // Both of these have to run on the empty path too, or clearing a walk leaves
  // a stale count on the handle and a stale label in an open popup.
  syncPopupButton();
  const badge = $("walk-badge");
  badge.textContent = String(walk.stops.length);
  badge.hidden = walk.stops.length === 0;

  section.hidden = walk.stops.length === 0;
  if (!walk.stops.length) {
    // Empty the list too, not just hide it. Switching to a city with no walk
    // otherwise leaves the previous city's rows in the DOM, complete with
    // handlers bound to ids that are no longer on the map.
    list.innerHTML = "";
    setSummary("");
    return;
  }

  list.innerHTML = "";

  walk.stops.forEach((id, index) => {
    const rec = window.FoodMap.record(id);
    const leg = index > 0 ? walk.legs[index - 1] : null;
    const li = document.createElement("li");

    if (leg) {
      const hop = document.createElement("p");
      hop.className = "walk-hop";
      hop.textContent =
        `${fmtDistance(leg.distance_m)} · ${fmtDuration(leg.duration_s)}`;
      li.appendChild(hop);
    }

    const row = document.createElement("div");
    row.className = "walk-row";
    row.innerHTML =
      `<span class="walk-n">${index + 1}</span>` +
      `<span class="walk-name">${rec.name_en || rec.name_cn}</span>`;

    const controls = document.createElement("span");
    controls.className = "walk-ctl";
    controls.innerHTML =
      `<button type="button" data-move="up" title="Move up"${index === 0 ? " disabled" : ""}>&uarr;</button>` +
      `<button type="button" data-move="down" title="Move down"${index === walk.stops.length - 1 ? " disabled" : ""}>&darr;</button>` +
      `<button type="button" data-remove title="Remove">&times;</button>`;

    controls.querySelector('[data-move="up"]').addEventListener("click", () => move(index, -1));
    controls.querySelector('[data-move="down"]').addEventListener("click", () => move(index, 1));
    controls.querySelector("[data-remove]").addEventListener("click", () => removeStop(id));

    row.appendChild(controls);
    row.addEventListener("mouseenter", () => highlight(id, true));
    row.addEventListener("mouseleave", () => highlight(id, false));
    li.appendChild(row);

    // A stop hidden by the current filters is still in the walk -- say so
    // rather than letting it silently vanish from the map.
    if (!window.FoodMap.isVisible(id)) {
      const note = document.createElement("p");
      note.className = "walk-hidden";
      note.textContent = "hidden by the current filters";
      li.appendChild(note);
    }

    list.appendChild(li);
  });

  $("walk-optimise").disabled = walk.stops.length < 3;

  if (walk.stops.length < 2) {
    setSummary("Add another stop to see the walk.");
    return;
  }
  if (walk.legs.length < walk.stops.length - 1) return;   // still fetching

  const distance = walk.legs.reduce((sum, l) => sum + l.distance_m, 0);
  const duration = walk.legs.reduce((sum, l) => sum + l.duration_s, 0);
  setSummary(
    `${walk.stops.length} stops · ${fmtDistance(distance)} · ${fmtDuration(duration)} walking`
  );
}

function highlight(id, on) {
  const marker = window.FoodMap.marker(id);
  if (marker && marker._icon) marker._icon.classList.toggle("pin-lit", on);
}

/* Push the current focus state down to the map. Focus is dropped whenever the
 * walk empties, since an empty map with the filters greyed out is a dead end. */
function applyFocus({ fit = false } = {}) {
  const box = $("walk-only");
  if (walk.only && !walk.stops.length) walk.only = false;
  box.checked = walk.only;
  box.parentElement.querySelector("em").textContent = walk.only
    ? "the filters above are paused"
    : "hides everywhere else on the map";
  window.FoodMap.setOnly(walk.only ? walk.stops : null, { fit });
}

/* --- popup feedback ---------------------------------------------------
 *
 * The popup is the only part of the walk UI guaranteed to be on screen at the
 * moment a stop is added. On a phone the panel's list is behind a collapsed
 * panel or below the fold of an open one, the summary line is in that same
 * panel, and the pin's own selected state is underneath the popup covering it
 * -- so every existing channel is invisible exactly when the feedback is
 * needed, and adding a stop reads as nothing happening.
 *
 * Reporting state on the button also makes the toggle visible. Pressing it a
 * second time has always removed the stop; unlabelled, that read as "still
 * nothing is happening" while quietly undoing the first press. */
let flashTimer = null;

/* Leaflet keeps one popup open at a time, so there is only ever one. */
function walkButton() {
  return document.querySelector("[data-add-walk]");
}

function syncPopupButton() {
  const button = walkButton();
  if (!button || button.dataset.flashing) return;
  const index = walk.stops.indexOf(button.dataset.addWalk);
  const inWalk = index >= 0;
  button.classList.toggle("in-walk", inWalk);
  button.setAttribute("aria-pressed", String(inWalk));
  button.textContent = inWalk ? `✓ Stop ${index + 1} · Remove` : "Add to walk";
}

/* Say it on the button as well as in the summary, for the same reason. */
function flashWalkButton(message) {
  const button = walkButton();
  if (!button) return;
  button.dataset.flashing = "1";
  button.classList.add("btn-warn");
  button.textContent = message;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    delete button.dataset.flashing;
    button.classList.remove("btn-warn");
    syncPopupButton();
  }, 2600);
}

/* Bring the walk into view when the panel is open but scrolled past it.
 * "nearest" is a no-op when the section is already visible, so this only moves
 * anything in the case where it would have landed off screen. */
function revealWalk() {
  if (document.getElementById("app").classList.contains("collapsed")) return;
  $("walk").scrollIntoView({ block: "nearest", behavior: "smooth" });
}

/* --- actions --------------------------------------------------------- */

function addStop(id) {
  if (walk.stops.includes(id)) {
    removeStop(id);
    return;
  }
  if (walk.stops.length >= MAX_STOPS) {
    setSummary(`That is enough for one day — ${MAX_STOPS} stops is the limit.`, false, true);
    flashWalkButton(`${MAX_STOPS} stops is the limit`);
    return;
  }
  walk.stops.push(id);
  applyFocus();
  markPins();
  routeAll();
  renderList();
  revealWalk();
}

function removeStop(id) {
  walk.stops = walk.stops.filter((s) => s !== id);
  applyFocus();
  markPins();
  routeAll();
  renderList();
}

function move(index, delta) {
  const target = index + delta;
  if (target < 0 || target >= walk.stops.length) return;
  const next = walk.stops.slice();
  [next[index], next[target]] = [next[target], next[index]];
  walk.stops = next;
  routeAll();
  renderList();
}

async function optimise() {
  const button = $("walk-optimise");
  button.disabled = true;
  // Wait for the table so the ordering is solved on real walking distance
  // rather than straight lines; falls through to straight lines if absent.
  await loadRoutes();
  const order = bestOrder(walk.stops);
  walk.stops = order.map((i) => walk.stops[i]);
  routeAll();
  renderList();
}

function clearWalk() {
  walk.stops = [];
  walk.legs = [];
  walk.token += 1;
  walk.only = false;
  applyFocus();
  markPins();
  drawRoute();
  renderList();
}

/* Selected pins carry a class so the map shows what is in the walk. */
function markPins() {
  document.querySelectorAll(".pin.pin-on").forEach((el) => el.classList.remove("pin-on"));
  walk.stops.forEach((id) => {
    const marker = window.FoodMap.marker(id);
    if (marker && marker._icon) marker._icon.classList.add("pin-on");
  });
}

/* One walk per city, swapped when the map changes city.
 *
 * The route table only holds within-city pairs -- that was deliberate, on the
 * grounds that nobody walks Shanghai to Hangzhou -- so a walk cannot span two
 * cities and there is nothing to merge. Keeping them rather than clearing means
 * looking up Suzhou mid-plan does not cost you the Shanghai walk you had. */
const walksByCity = new Map();

function swapCityWalk({ city, previous }) {
  walksByCity.set(previous, { stops: walk.stops.slice(), only: walk.only });

  const saved = walksByCity.get(city) || { stops: [], only: false };
  walk.stops = saved.stops.slice();
  walk.only = saved.only;
  walk.legs = [];
  walk.token += 1;               // strand any route request still in flight
  $("walk-only").checked = walk.only;

  // setOnly() before the map re-renders, so it renders once with the right set.
  window.FoodMap.setOnly(walk.only ? walk.stops : null);
  drawRoute();
  renderList();
  if (walk.stops.length) routeAll();
}

function init() {
  // Popups are rebuilt by Leaflet, so the button is caught by delegation.
  document.addEventListener("click", (e) => {
    const button = e.target.closest("[data-add-walk]");
    if (button) addStop(button.dataset.addWalk);
  });

  // A popup is built fresh each time it opens, so its button starts on the
  // default label and has to be told what the walk already contains.
  window.FoodMap.map.on("popupopen", syncPopupButton);

  document.addEventListener("map:citychange", (e) => swapCityWalk(e.detail));

  $("walk-optimise").addEventListener("click", optimise);
  $("walk-clear").addEventListener("click", clearWalk);

  $("walk-only").addEventListener("change", (e) => {
    walk.only = e.target.checked;
    // Zoom to the walk on the way in; on the way out, back to what is showing.
    applyFocus({ fit: true });
  });

  // Filtering re-adds markers, which drops the selected class and any route
  // drawn beneath them.
  document.addEventListener("map:rendered", () => {
    markPins();
    renderList();
  });

  renderList();
}

if (window.FoodMap) init();
else document.addEventListener("map:ready", init, { once: true });
