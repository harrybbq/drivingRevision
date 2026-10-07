// Small DOM helpers. Data only ever goes into the page as text nodes or
// attributes, never as HTML, so nothing in tips.json can inject markup.

// h('p', { class: 'x', onclick: fn }, 'text', child) → element.
// Strings become text nodes. `false`/`null` props and children are skipped.
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'dataset') Object.assign(el.dataset, value);
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined && child !== false) el.append(child);
  }
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

export function svg(tag, attrs = {}, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  el.append(...children);
  return el;
}

// Line icons (24×24, stroke = currentColor).
const ICONS = {
  plus: ['M12 5v14', 'M5 12h14'],
  locate: ['M12 2v3', 'M12 19v3', 'M2 12h3', 'M19 12h3', 'M12 8a4 4 0 1 0 0 8a4 4 0 1 0 0-8'],
  // Feather "settings" (MIT).
  gear: [
    'M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6',
    'M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z',
  ],
  check: ['M5 12.5l4.5 4.5L19 7.5'],
  back: ['M15 5l-7 7l7 7'],
  edit: ['M4 20h4L19 9l-4-4L4 16v4', 'M13.5 6.5l4 4'],
  move: ['M12 3v18', 'M3 12h18', 'M9 6l3-3l3 3', 'M9 18l3 3l3-3', 'M6 9l-3 3l3 3', 'M18 9l3 3l-3 3'],
  pin: ['M12 21s-7-6.5-7-12a7 7 0 0 1 14 0c0 5.5-7 12-7 12z', 'M12 7a2 2 0 1 0 0 4a2 2 0 1 0 0-4'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 13h10l1-13', 'M9 7V4h6v3'],
  copy: ['M9 9h11v11H9z', 'M5 15H4V4h11v1'],
  upload: ['M12 16V4', 'M7 9l5-5l5 5', 'M4 20h16'],
  // A hand-drawn arrow, for drawing on the map.
  draw: ['M4 20c1.5-4.5 4.5-6 8-7s6.5-3 8-8.5', 'M15 5.5l5-1.5l1.5 5'],
  undo: ['M9 14L4 9l5-5', 'M4 9h10.5a5.5 5.5 0 0 1 0 11H11'],
};

export function icon(name) {
  return svg(
    'svg',
    { viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', 'stroke-width': 2, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true', focusable: 'false' },
    ...ICONS[name].map((d) => svg('path', { d })),
  );
}

// Toasts: short messages at the top. `action` is { label, href } or { label, onClick }.
export function toast(container, message, { action = null, error = false, ms = 5000 } = {}) {
  const close = () => el.remove();
  let actionEl = null;
  if (action?.href) {
    actionEl = h('a', { href: action.href, target: '_blank', rel: 'noopener' }, action.label);
  } else if (action?.onClick) {
    actionEl = h('button', { type: 'button', class: 'toast-action', onclick: () => { close(); action.onClick(); } }, action.label);
  }
  const el = h(
    'div',
    { class: `toast${error ? ' toast-error' : ''}`, role: error ? 'alert' : 'status' },
    h('p', {}, message),
    actionEl,
    h('button', { type: 'button', class: 'toast-close', 'aria-label': 'Dismiss', onclick: close }, '×'),
  );
  for (const old of [...container.children]) {
    if (old.querySelector('p')?.textContent === message) old.remove();
  }
  container.append(el);
  while (container.children.length > 2) container.firstElementChild.remove();
  if (ms) setTimeout(close, action ? ms * 1.6 : ms);
  return el;
}

// Copies text. Returns false if the browser refused, so the caller can show it for manual copying.
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// localStorage, or null where it's blocked (some private modes throw on access).
export function safeStorage() {
  try {
    const storage = globalThis.localStorage;
    storage.getItem('probe');
    return storage;
  } catch {
    return null;
  }
}

export const prefersReducedMotion = () => globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
