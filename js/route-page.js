// The test route page: fetches the route's streets from OpenStreetMap (in the
// browser, via Overpass), works out the route with route-solve.js, and draws it
// with the turns numbered to match the list. The result is kept on this device.

import { ROUTE } from './route-data.js';
import { solveRoute, overpassQuery } from './route-solve.js';
import { h, safeStorage, prefersReducedMotion } from './dom.js';
import { Sheet } from './sheet.js';

const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter'];
const CACHE_KEY = `drivingRevision:route:${ROUTE.id}`;
const ROUTE_COLOUR = '#1F5FAD';
const DESKTOP = '(min-width: 900px)';

const storage = safeStorage();
const $ = (id) => document.getElementById(id);
const body = $('panel-body');
const sheet = new Sheet($('panel'), $('panel-grab'));

let result = null; // what solveRoute returned
let state = { loading: true, error: null, selected: null };

// --------------------------------------------------------------------- map

const L = globalThis.L;
let map = null;
let layer = null;
const turnMarkers = new Map(); // step index → Leaflet marker

if (L) {
  map = L.map('map', { attributionControl: false, zoomSnap: 0.5 }).setView([55.948, -4.765], 14);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
  }).addTo(map);
  const credit = L.control.attribution({ prefix: '<a href="https://leafletjs.com">Leaflet</a>' }).addTo(map);
  const desktop = matchMedia(DESKTOP);
  const placeCredit = () => credit.setPosition(desktop.matches ? 'bottomright' : 'topright');
  desktop.addEventListener('change', () => {
    placeCredit();
    map.invalidateSize();
  });
  placeCredit();
  layer = L.layerGroup().addTo(map);
} else {
  $('map').append(h('p', { class: 'map-fallback' }, "The map couldn't load (no connection?). The directions are still in the list."));
}

function drawRoute() {
  if (!map || !result) return;
  layer.clearLayers();
  turnMarkers.clear();
  // White casing first, then the route on top, so it reads on any tiles.
  for (const line of result.lines) {
    L.polyline(line.path, { color: '#fff', weight: 9, opacity: 0.9, interactive: false }).addTo(layer);
  }
  for (const line of result.lines) {
    L.polyline(line.path, { color: ROUTE_COLOUR, weight: 5, dashArray: line.approx ? '6 7' : null, interactive: false }).addTo(layer);
  }
  for (const m of result.markers) {
    const label = h('span', { class: `turn${m.approx ? ' is-approx' : ''}` }, m.step === 0 ? 'DTC' : String(m.step + 1));
    const marker = L.marker(m.at, {
      icon: L.divIcon({ html: label, className: 'turn-icon', iconSize: [44, 44], iconAnchor: [22, 22] }),
      keyboard: true,
      zIndexOffset: 100 + m.step,
    }).addTo(layer);
    marker.getElement().setAttribute('aria-label', `Turn ${m.step + 1}: ${ROUTE.steps[m.step].road}, ${ROUTE.steps[m.step].direction}`);
    marker.on('click', () => select(m.step, { fly: false }));
    turnMarkers.set(m.step, marker);
  }
  fitRoute();
}

function fitRoute() {
  if (!map || !result) return;
  const points = [...result.lines.flatMap((l) => l.path), ...result.markers.map((m) => m.at)];
  if (!points.length) return;
  map.fitBounds(points, { paddingTopLeft: [24, 24], paddingBottomRight: [24, 24 + sheet.covered()], maxZoom: 16, animate: !prefersReducedMotion() });
}

function flyTo(at) {
  const zoom = Math.max(map.getZoom(), 17);
  const point = map.project(at, zoom).add([0, sheet.covered() / 2]);
  const target = map.unproject(point, zoom);
  if (prefersReducedMotion()) map.setView(target, zoom);
  else map.flyTo(target, zoom, { duration: 0.6 });
}

// ------------------------------------------------------------------- panel

function select(step, { fly = true } = {}) {
  state.selected = step;
  for (const [i, marker] of turnMarkers) {
    marker.getElement()?.querySelector('.turn')?.classList.toggle('is-selected', i === step);
    marker.setZIndexOffset(i === step ? 1000 : 100 + i);
  }
  render();
  const marker = result?.markers.find((m) => m.step === step);
  if (marker && map) {
    if (sheet.state === 'full') sheet.set('half');
    if (fly) flyTo(marker.at);
  }
}

function statusLine() {
  if (state.loading) return h('p', { class: 'route-status', role: 'status' }, 'Finding the route on OpenStreetMap…');
  if (state.error) return h('p', { class: 'route-status bad', role: 'alert' }, state.error);
  const placed = new Set(result.markers.map((m) => m.step)).size;
  return h('p', { class: 'route-status', role: 'status' },
    `${placed} of ${ROUTE.steps.length} turns placed on the map. Tap a turn to see it.`,
    result.markers.some((m) => m.approx) ? ' Dashed ones are approximate.' : '');
}

function render() {
  const problems = new Map();
  for (const p of result?.problems ?? []) problems.set(p.step, [...(problems.get(p.step) ?? []), p.message]);
  const placed = new Set(result?.markers.map((m) => m.step) ?? []);
  const scroll = body.scrollTop;
  body.replaceChildren(
    h('div', { class: 'route-head' },
      h('h2', {}, ROUTE.title),
      h('p', { class: 'route-key' }, 'T/L traffic lights · EOR end of road'),
      statusLine()),
    h('div', { class: 'route-actions' },
      result && map && h('button', { type: 'button', class: 'btn', onclick: fitRoute }, 'Whole route'),
      !state.loading && h('button', { type: 'button', class: 'btn', onclick: () => load({ fresh: true }) }, state.error ? 'Try again' : 'Look up again')),
    h('ol', { class: 'route-steps' },
      ROUTE.steps.map((step, i) =>
        h('li', { class: `route-step${state.selected === i ? ' is-selected' : ''}${result && !placed.has(i) ? ' is-unplaced' : ''}` },
          h('button', { type: 'button', class: 'step-main', 'aria-current': state.selected === i ? 'step' : null, onclick: () => select(i) },
            h('span', { class: 'num', 'aria-hidden': 'true' }, String(i + 1)),
            h('span', { class: 'road' }, step.road),
            h('span', { class: 'dir' }, step.direction),
            ...(problems.get(i) ?? []).map((message) => h('span', { class: 'note' }, message)),
            result && !placed.has(i) && !problems.has(i) && i > 0 && h('span', { class: 'note' }, 'Not placed on the map.'))))),
  );
  body.scrollTop = scroll;
}

// -------------------------------------------------------------------- data

async function fetchOsm(query) {
  let lastError = null;
  for (const url of OVERPASS) {
    try {
      const res = await fetch(url, { method: 'POST', body: new URLSearchParams({ data: query }) });
      if (res.ok) return await res.json();
      lastError = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError ?? new Error('no response');
}

// The cached result is only reused for exactly the same route.
const signature = JSON.stringify(ROUTE.steps.map((s) => s.names));

function readCache() {
  try {
    const saved = JSON.parse(storage?.getItem(CACHE_KEY) ?? 'null');
    return saved?.signature === signature ? saved.result : null;
  } catch {
    return null;
  }
}

function writeCache(value) {
  try {
    storage?.setItem(CACHE_KEY, JSON.stringify({ signature, result: value, at: Date.now() }));
  } catch {
    // Not remembered; it'll be looked up again next time.
  }
}

async function load({ fresh = false } = {}) {
  const cached = fresh ? null : readCache();
  if (cached) {
    result = cached;
    state = { loading: false, error: null, selected: state.selected };
    render();
    drawRoute();
    return;
  }
  state = { loading: true, error: null, selected: null };
  render();
  try {
    const osm = await fetchOsm(overpassQuery(ROUTE.steps));
    result = solveRoute(ROUTE.steps, osm);
    if (result.markers.length) writeCache(result);
    state = { loading: false, error: null, selected: null };
  } catch (err) {
    state = { loading: false, error: `Couldn't reach OpenStreetMap (${err.message}). Check your signal and try again.`, selected: null };
  }
  render();
  drawRoute();
}

sheet.set('half');
load();
