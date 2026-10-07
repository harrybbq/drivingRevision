// The Leaflet map: numbered pins, the draft pin for a new tip, placing and
// moving pins, the open tip's drawn marks, and "Where am I". It knows nothing
// about saving.

import { svg, prefersReducedMotion } from './dom.js';
import { isPinned } from './tips.js';

export const START = { lat: 55.955, lng: -4.78, zoom: 14 };
const DESKTOP = '(min-width: 900px)';
const FOCUS_ZOOM = 16;
// Marks look like red pen on a screenshot: red over a white casing, so they
// read on light and dark tiles alike. Keep in step with --mark in app.css.
const RED = '#D7261E';
const CASING = '#FFFFFF';

// A teardrop with the number in the round part. Built with DOM calls, not HTML strings.
function pinSvg(label) {
  const size = label.length >= 3 ? 10.5 : 13;
  return svg(
    'svg',
    { width: 32, height: 42, viewBox: '0 0 32 42', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: 'M16 40.5C11.5 34.8 3 25.7 3 16a13 13 0 0 1 26 0c0 9.7-8.5 18.8-13 24.5z' }),
    svg('text', { x: 16, y: 16.5, 'text-anchor': 'middle', 'dominant-baseline': 'central', style: `font-size:${size}px` }, label),
  );
}

function pinIcon(L, { label, className }) {
  return L.divIcon({ html: pinSvg(label), className: `pin ${className}`, iconSize: [44, 52], iconAnchor: [22, 50] });
}

// Arrowhead size on screen, in pixels. The line stops partway into the head, so
// its round end never shows past the tip.
const HEAD = { length: 20, halfWidth: 9, cut: 12 };

// Cuts `len` pixels off the end of a line of projected points.
function trimEnd(px, len) {
  const out = px.slice();
  let left = len;
  while (out.length > 1) {
    const end = out.at(-1);
    const prev = out.at(-2);
    const d = end.distanceTo(prev);
    if (d > left) {
      out[out.length - 1] = end.add(prev.subtract(end).multiplyBy(left / d));
      return out;
    }
    left -= d;
    out.pop();
  }
  return out;
}

// The shaft and head of an arrow at zoom z. Both are worked out in screen pixels,
// so the head points along the last stretch of road and keeps its size.
function arrowShape(map, points, z) {
  const px = points.map((p) => map.project(p, z));
  const tip = px.at(-1);
  // The last point that's somewhere else, so tapping one spot twice doesn't spin the head.
  const from = px.slice(0, -1).reverse().find((p) => p.distanceTo(tip) > 0.5);
  if (!from) return { shaft: points, head: [] };
  const d = tip.distanceTo(from);
  const ux = (tip.x - from.x) / d;
  const uy = (tip.y - from.y) / d;
  const base = tip.subtract([ux * HEAD.length, uy * HEAD.length]);
  const side = [-uy * HEAD.halfWidth, ux * HEAD.halfWidth];
  const head = [tip, base.add(side), base.subtract(side)];
  const toLatLng = (p) => map.unproject(p, z);
  return { shaft: trimEnd(px, HEAD.cut).map(toLatLng), head: head.map(toLatLng) };
}

// An S-shaped arrow shifting up and to the right; CSS mirrors it for "left".
function laneSvg() {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', 'aria-hidden': 'true', focusable: 'false' },
    svg('path', { d: 'M8 21v-4c0-3.5 8-4.5 8-8V4' }),
    svg('path', { d: 'M12 7.5L16 3.5l4 4' }),
  );
}

// Every [lat, lng] a mark covers, for fitting the view to a drawing.
const markPoints = (marks = []) => marks.flatMap((m) => m.points ?? [m.at]);

export class TipMap {
  constructor(el, wrap, { onSelect }) {
    const L = globalThis.L;
    this.L = L;
    this.wrap = wrap;
    this.onSelect = onSelect;
    this.markers = new Map(); // id → { marker, key }
    this.moving = null;
    this.placing = null;
    this.draft = null;
    this.drawing = null;
    this.you = null;

    this.map = L.map(el, { attributionControl: false, zoomSnap: 0.5 }).setView([START.lat, START.lng], START.zoom);
    // Marks sit above the tiles but below the pins (600), and never take taps.
    // The pane's renderer is made now so its <svg> comes before any marker icons.
    this.map.createPane('marks').style.zIndex = 450;
    this.marksRenderer = L.svg({ pane: 'marks' }).addTo(this.map);
    this.marks = L.layerGroup().addTo(this.map);
    this.marksKey = '';
    this.arrows = []; // { points, layers } for reshaping arrowheads when the zoom changes
    this.map.on('zoomend', () => this.shapeArrows());
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(this.map);
    // The credit must stay visible: on phones the sheet covers the bottom of the map, so it goes top right.
    this.attribution = L.control.attribution({ prefix: '<a href="https://leafletjs.com">Leaflet</a>' }).addTo(this.map);
    const desktop = matchMedia(DESKTOP);
    const placeCredit = () => this.attribution.setPosition(desktop.matches ? 'bottomright' : 'topright');
    desktop.addEventListener('change', () => {
      placeCredit();
      this.map.invalidateSize();
    });
    placeCredit();
    this.map.on('click', (e) => this.handleClick(e));
  }

  handleClick(e) {
    if (this.drawing) {
      this.drawing({ lat: e.latlng.lat, lng: e.latlng.lng });
    } else if (this.placing) {
      const done = this.placing;
      this.stopPlacing();
      done({ lat: e.latlng.lat, lng: e.latlng.lng });
    } else if (this.moving) {
      this.markers.get(this.moving.id)?.marker.setLatLng(e.latlng);
    }
  }

  // Shows the pinned tips in `tips` (already numbered and filtered). Pins in
  // `localIds` have changes only on this device and get a dashed outline.
  render(tips, selectedId, localIds = new Set()) {
    const seen = new Set();
    for (const tip of tips) {
      if (!isPinned(tip)) continue;
      seen.add(tip.id);
      const selected = tip.id === selectedId;
      const moving = this.moving?.id === tip.id;
      const local = localIds.has(tip.id);
      const className = [`cat-${tip.cat}`, tip.status === 'known' && 'is-known', selected && 'is-selected', moving && 'is-moving', local && 'is-local'].filter(Boolean).join(' ');
      const key = `${tip.num}|${className}|${tip.where}`;
      let entry = this.markers.get(tip.id);
      if (!entry) {
        const marker = this.L.marker([tip.lat, tip.lng], { keyboard: true, riseOnHover: true }).addTo(this.map);
        marker.on('click', () => {
          if (!this.placing && !this.moving && !this.drawing) this.onSelect(tip.id);
        });
        entry = { marker, key: '' };
        this.markers.set(tip.id, entry);
      }
      if (!moving) entry.marker.setLatLng([tip.lat, tip.lng]);
      if (entry.key !== key) {
        entry.marker.setIcon(pinIcon(this.L, { label: String(tip.num), className }));
        entry.marker.setZIndexOffset(selected || moving ? 1000 : 0);
        const el = entry.marker.getElement();
        el.setAttribute('aria-label', `Tip ${tip.num}: ${tip.where}${local ? ' (only on this device)' : ''}`);
        el.dataset.id = tip.id;
        entry.key = key;
      }
    }
    for (const [id, entry] of this.markers) {
      if (!seen.has(id) && this.moving?.id !== id) {
        entry.marker.remove();
        this.markers.delete(id);
      }
    }
  }

  // Centres a point in the part of the map the sheet doesn't cover.
  focus({ lat, lng }, covered = 0, zoom = Math.max(this.map.getZoom(), FOCUS_ZOOM)) {
    const point = this.map.project([lat, lng], zoom).add([0, covered / 2]);
    const target = this.map.unproject(point, zoom);
    if (prefersReducedMotion()) this.map.setView(target, zoom);
    else this.map.flyTo(target, zoom, { duration: 0.7 });
  }

  // Opens a tip with a drawing: fits the pin and every mark into the part of the
  // map the sheet doesn't cover. A tip with nothing drawn is just centred.
  fitTip(tip, covered = 0) {
    const points = markPoints(tip.marks);
    if (!points.length) {
      this.focus(tip, covered);
      return;
    }
    const bounds = this.L.latLngBounds([[tip.lat, tip.lng], ...points]);
    const options = { paddingTopLeft: [48, 48], paddingBottomRight: [48, covered + 48], maxZoom: 18 };
    if (prefersReducedMotion()) this.map.fitBounds(bounds, options);
    else this.map.flyToBounds(bounds, { ...options, duration: 0.7 });
  }

  // ------------------------------------------------------ drawn marks

  // Draws one tip's marks, plus `pending`: the points tapped so far for an arrow
  // or give-way line that isn't finished. The page re-renders on every poll, so
  // nothing is redrawn unless something changed.
  showMarks(marks, { pending = [] } = {}) {
    const key = JSON.stringify([marks, pending]);
    if (key === this.marksKey) return;
    this.marks.clearLayers();
    this.marksKey = key;
    this.arrows = [];
    const L = this.L;
    const base = { pane: 'marks', renderer: this.marksRenderer, interactive: false, opacity: 1, lineCap: 'round', lineJoin: 'round' };
    const add = (layer) => layer.addTo(this.marks);
    const casing = (className) => ({ ...base, className, color: CASING, weight: 9 });
    const red = (className) => ({ ...base, className, color: RED, weight: 5 });

    // Every white casing goes under every red line, so the marks read as one pen
    // stroke with a white edge, arrowheads included.
    const casings = [];
    const reds = [];
    for (const mark of marks) {
      if (mark.type === 'arrow') {
        const arrow = { points: mark.points, layers: [] };
        arrow.layers.push(
          L.polyline([], casing('mark-casing')),
          L.polygon([], { ...casing('mark-head-casing'), weight: 4, fillColor: CASING, fillOpacity: 1 }),
          L.polyline([], red('mark-arrow')),
          L.polygon([], { ...red('mark-head'), stroke: false, fillColor: RED, fillOpacity: 1 }),
        );
        casings.push(arrow.layers[0], arrow.layers[1]);
        reds.push(arrow.layers[2], arrow.layers[3]);
        this.arrows.push(arrow);
      } else if (mark.type === 'giveway') {
        // Dashed like give-way road markings.
        casings.push(L.polyline(mark.points, casing('mark-casing')));
        reds.push(L.polyline(mark.points, { ...red('mark-giveway'), dashArray: '8 7', lineCap: 'butt' }));
      }
    }
    this.shapeArrows();
    [...casings, ...reds].forEach(add);

    // Symbols go over the lines.
    const icon = (at, className, html, size) =>
      add(L.marker(at, { pane: 'marks', interactive: false, keyboard: false, icon: L.divIcon({ className, html, iconSize: size }) }));
    for (const mark of marks) {
      if (mark.type === 'lane') {
        icon(mark.at, 'mark-lane', laneSvg(), [32, 32]).getElement().setAttribute('data-dir', mark.dir === 'left' ? 'left' : 'right');
      } else if (mark.type === 'label') {
        const text = document.createElement('span');
        text.textContent = mark.text; // typed by the user: text only, never HTML
        icon(mark.at, 'mark-label', text, null);
      }
    }

    // The arrow or give-way line being drawn: a dot per tap, joined by a dashed preview.
    if (pending.length > 1) add(L.polyline(pending, { ...base, className: 'mark-preview', color: RED, weight: 3, opacity: 0.9, dashArray: '4 6' }));
    for (const point of pending) {
      add(L.circleMarker(point, { ...base, className: 'mark-point', radius: 6, color: CASING, weight: 2, fillColor: RED, fillOpacity: 1 }));
    }
  }

  clearMarks() {
    if (!this.marksKey) return;
    this.marks.clearLayers();
    this.marksKey = '';
    this.arrows = [];
  }

  // Arrowheads stay the same size on screen, so they're reshaped at each new zoom.
  shapeArrows() {
    const z = this.map.getZoom();
    for (const { points, layers } of this.arrows) {
      const { shaft, head } = arrowShape(this.map, points, z);
      const [shaftCasing, headCasing, shaftRed, headRed] = layers;
      shaftCasing.setLatLngs(shaft);
      shaftRed.setLatLngs(shaft);
      headCasing.setLatLngs(head);
      headRed.setLatLngs(head);
    }
  }

  // Draw mode: every map tap goes to onTap, and pins let taps through.
  startDrawing(onTap) {
    this.drawing = onTap;
    this.wrap.classList.add('is-placing');
    this.map.doubleClickZoom.disable(); // quick taps along a road shouldn't zoom
  }

  stopDrawing() {
    if (!this.drawing) return;
    this.drawing = null;
    this.wrap.classList.remove('is-placing');
    this.map.doubleClickZoom.enable();
  }

  // ------------------------------------------------- placing a new pin

  startPlacing(onPlace) {
    this.placing = onPlace;
    this.wrap.classList.add('is-placing');
  }

  stopPlacing() {
    this.placing = null;
    this.wrap.classList.remove('is-placing');
  }

  // The "+" pin shown while the add form is open. Drag it to adjust.
  showDraft(latlng, onMove) {
    this.clearDraft();
    this.draft = this.L.marker([latlng.lat, latlng.lng], {
      draggable: true,
      keyboard: false,
      zIndexOffset: 2000,
      icon: pinIcon(this.L, { label: '+', className: 'is-draft' }),
    }).addTo(this.map);
    this.draft.getElement().setAttribute('aria-label', 'New tip position (drag to adjust)');
    this.draft.on('dragend', () => onMove(this.draft.getLatLng()));
  }

  clearDraft() {
    this.draft?.remove();
    this.draft = null;
  }

  // ------------------------------------------------- moving an existing pin

  // Lets the pin be dragged, or moved by tapping the map. Returns false if it isn't on the map.
  startMoving(tip) {
    const entry = this.markers.get(tip.id);
    if (!entry) return false;
    this.moving = { id: tip.id, from: entry.marker.getLatLng() };
    entry.key = ''; // force a redraw with the moving style
    entry.marker.dragging.enable();
    this.wrap.classList.add('is-moving');
    return true;
  }

  // Ends move mode. Returns the new position, or null if cancelled or nothing moved.
  stopMoving(keep) {
    if (!this.moving) return null;
    const { id, from } = this.moving;
    this.moving = null;
    this.wrap.classList.remove('is-moving');
    const entry = this.markers.get(id);
    if (!entry) return null;
    entry.marker.dragging.disable();
    entry.key = '';
    const to = entry.marker.getLatLng();
    if (!keep) {
      entry.marker.setLatLng(from);
      return null;
    }
    return to.equals(from) ? null : { lat: to.lat, lng: to.lng };
  }

  // ------------------------------------------------------- where am I

  showYou({ lat, lng, accuracy }) {
    this.you?.forEach((layer) => layer.remove());
    this.you = [
      this.L.circle([lat, lng], { radius: accuracy, interactive: false, color: '#2B7DE9', weight: 1, opacity: 0.6, fillOpacity: 0.12 }),
      this.L.circleMarker([lat, lng], { radius: 8, interactive: false, color: '#fff', weight: 3, fillColor: '#2B7DE9', fillOpacity: 1 }),
    ];
    this.you.forEach((layer) => layer.addTo(this.map));
  }
}

// Resolves { lat, lng, accuracy } or rejects with a message fit to show.
export function locate() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser can't share your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => resolve({ lat: coords.latitude, lng: coords.longitude, accuracy: Math.round(coords.accuracy) }),
      (err) => reject(new Error(
        err.code === err.PERMISSION_DENIED
          ? 'Location is blocked for this site. Allow it in your browser settings, then try again.'
          : err.code === err.TIMEOUT
            ? 'Finding your location took too long. Try again with a clearer view of the sky.'
            : "Couldn't find your location.",
      )),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 10000 },
    );
  });
}
