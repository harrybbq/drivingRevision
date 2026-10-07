// The Leaflet map: numbered pins, the draft pin for a new tip, placing and
// moving pins, and "Where am I". It knows nothing about saving.

import { svg, prefersReducedMotion } from './dom.js';
import { isPinned } from './tips.js';

export const START = { lat: 55.955, lng: -4.78, zoom: 14 };
const DESKTOP = '(min-width: 900px)';
const FOCUS_ZOOM = 16;

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
    this.you = null;

    this.map = L.map(el, { attributionControl: false, zoomSnap: 0.5 }).setView([START.lat, START.lng], START.zoom);
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
    if (this.placing) {
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
          if (!this.placing && !this.moving) this.onSelect(tip.id);
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
