// Tip data for the map: categories, validation, numbering, filtering, and the
// bookkeeping that keeps local edits on screen until GitHub Pages serves them.
// Nothing in here touches the DOM, so it runs the same in the page and in Node tests.

export const CATEGORIES = Object.freeze([
  { key: 'junction', label: 'Junction or roundabout' },
  { key: 'speed', label: 'Speed limit' },
  { key: 'lanes', label: 'Lanes & road markings' },
  { key: 'hill', label: 'Hill' },
  { key: 'priority', label: 'Narrow road or priority' },
  { key: 'hazard', label: 'Hazard (school, crossing, bus stop)' },
  { key: 'manoeuvre', label: 'Manoeuvre spot' },
  { key: 'other', label: 'Other' },
]);
const CATEGORY_KEYS = new Set(CATEGORIES.map((c) => c.key));

export function categoryLabel(key) {
  return CATEGORIES.find((c) => c.key === key)?.label ?? 'Other';
}

export const FILTERS = Object.freeze([
  { key: 'all', label: 'All' },
  { key: 'learning', label: 'Still learning' },
  { key: 'known', label: 'Got it' },
]);

// Form limits. Loading doesn't enforce them, so an over-long tip in tips.json still shows.
export const LIMITS = Object.freeze({ where: 120, rule: 1000, why: 1000 });

// Limits on what's drawn for a tip. Unlike LIMITS these are enforced on load
// (extra marks and points are cut off, long labels shortened): drawings come
// from the page, not from typing, so there's nothing worth showing past them.
export const MARK_LIMITS = Object.freeze({ marks: 30, points: 40, label: 40 });

const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export class TipsError extends Error {
  name = 'TipsError';
}

// ---------------------------------------------------------------- validation

function cleanText(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

const oneLine = (s) => s.replace(/\s+/g, ' ').trim();

function isCoord(value, max) {
  return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= max;
}

const round6 = (n) => Math.round(n * 1e6) / 1e6; // ~10 cm, plenty for a pin

// One [lat, lng] position, or null if it isn't one.
function cleanPoint(value) {
  return Array.isArray(value) && value.length === 2 && isCoord(value[0], 90) && isCoord(value[1], 180)
    ? [round6(value[0]), round6(value[1])]
    : null;
}

// A list of positions, or null if any of them is bad.
function cleanPoints(value) {
  const points = value.map(cleanPoint);
  return points.includes(null) ? null : points;
}

// Label text is shown as plain text, so it only needs tidying, not escaping here.
function cleanLabel(value) {
  if (typeof value !== 'string') return '';
  const cut = oneLine(value).slice(0, MARK_LIMITS.label);
  return cut.replace(/[\uD800-\uDBFF]$/, '').trim(); // don't leave half an emoji at the cut
}

// Checks one mark and returns a fresh copy with only the keys its type uses,
// or null if it can't be drawn.
function cleanMark(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const { type } = raw;
  if (type === 'arrow') {
    const points = Array.isArray(raw.points) && raw.points.length >= 2
      ? cleanPoints(raw.points.slice(0, MARK_LIMITS.points))
      : null;
    return points && { type, points };
  }
  if (type === 'giveway') {
    const points = Array.isArray(raw.points) && raw.points.length === 2 ? cleanPoints(raw.points) : null;
    return points && { type, points };
  }
  if (type === 'lane') {
    const at = cleanPoint(raw.at);
    return at && (raw.dir === 'left' || raw.dir === 'right') ? { type, dir: raw.dir, at } : null;
  }
  if (type === 'label') {
    const text = cleanLabel(raw.text);
    const at = cleanPoint(raw.at);
    return text && at ? { type, text, at } : null;
  }
  return null;
}

// A bad mark is dropped on its own; it never hides the tip or the other marks.
function cleanMarks(value) {
  return Array.isArray(value) ? value.map(cleanMark).filter(Boolean).slice(0, MARK_LIMITS.marks) : [];
}

// Checks one entry from tips.json (or localStorage) and returns a clean copy.
// Unknown categories fall back to "other" and unknown statuses to "learning"
// rather than hiding the tip; a half-set position counts as not pinned.
// marks is always a list, empty when there's nothing (usable) drawn.
export function validateTip(raw) {
  const fail = (reason) => ({ ok: false, reason });
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('not an object');
  if (typeof raw.id !== 'string' || !ID_PATTERN.test(raw.id)) return fail('missing or invalid "id"');
  const where = cleanText(raw.where);
  if (!where) return fail('missing "where"');
  const rule = cleanText(raw.rule);
  if (!rule) return fail('missing "rule"');
  const created = typeof raw.createdAt === 'string' ? Date.parse(raw.createdAt) : NaN;
  if (!Number.isFinite(created)) return fail('missing or invalid "createdAt"');
  const pinned = isCoord(raw.lat, 90) && isCoord(raw.lng, 180);
  return {
    ok: true,
    tip: {
      id: raw.id,
      where,
      cat: CATEGORY_KEYS.has(raw.cat) ? raw.cat : 'other',
      rule,
      why: cleanText(raw.why),
      lat: pinned ? round6(raw.lat) : null,
      lng: pinned ? round6(raw.lng) : null,
      status: raw.status === 'known' ? 'known' : 'learning',
      createdAt: new Date(created).toISOString(),
      marks: cleanMarks(raw.marks),
    },
  };
}

// Validates a whole tips.json array. Bad entries are reported, not thrown, so one
// broken tip doesn't take the rest down with it.
export function parseTips(data) {
  if (!Array.isArray(data)) throw new TipsError('tips.json should hold a list of tips: [ ... ]');
  const tips = [];
  const rejected = [];
  const seen = new Set();
  data.forEach((raw, index) => {
    const result = validateTip(raw);
    if (!result.ok) rejected.push({ index, reason: result.reason });
    else if (seen.has(result.tip.id)) rejected.push({ index, reason: `duplicate id "${result.tip.id}"` });
    else {
      seen.add(result.tip.id);
      tips.push(result.tip);
    }
  });
  return { tips, rejected };
}

// Messages for the add/edit form. Empty object means the fields are fine.
export function fieldErrors({ where, cat, rule, why } = {}) {
  const errors = {};
  const w = cleanText(where);
  const r = cleanText(rule);
  if (!w) errors.where = 'Say where this is.';
  else if (w.length > LIMITS.where) errors.where = `Keep it under ${LIMITS.where} characters.`;
  if (!CATEGORY_KEYS.has(cat)) errors.cat = 'Pick a category.';
  if (!r) errors.rule = 'Say what to do here.';
  else if (r.length > LIMITS.rule) errors.rule = `Keep it under ${LIMITS.rule} characters.`;
  if (cleanText(why).length > LIMITS.why) errors.why = `Keep it under ${LIMITS.why} characters.`;
  return errors;
}

// ------------------------------------------------------------ creating tips

const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

export function makeId(taken = new Set()) {
  for (;;) {
    let id = '';
    for (const byte of globalThis.crypto.getRandomValues(new Uint8Array(8))) id += ID_ALPHABET[byte % 36];
    if (!taken.has(id)) return id;
  }
}

export function newTip({ where, cat, rule, why = '', lat = null, lng = null }, { ids = [], now = new Date() } = {}) {
  const result = validateTip({
    id: makeId(new Set(ids)),
    where, cat, rule, why, lat, lng,
    status: 'learning',
    createdAt: now.toISOString(),
  });
  if (!result.ok) throw new TipsError(`Can't create tip: ${result.reason}`);
  return result.tip;
}

// Returns an edited copy. id and createdAt never change, so the tip keeps its number.
export function updateTip(tip, changes) {
  const result = validateTip({ ...tip, ...changes, id: tip.id, createdAt: tip.createdAt });
  if (!result.ok) throw new TipsError(`Can't update tip: ${result.reason}`);
  return result.tip;
}

// -------------------------------------------------- numbering and filtering

export const isPinned = (tip) => tip.lat !== null && tip.lng !== null;

function byCreated(a, b) {
  // createdAt is normalised to ISO-8601 UTC, so string order is time order.
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

// Numbers every tip by createdAt (1 = oldest). Number before filtering, so a
// tip keeps its number whichever filter is on.
export function numberTips(tips) {
  return [...tips].sort(byCreated).map((tip, i) => ({ ...tip, num: i + 1 }));
}

export function filterTips(tips, filter) {
  return filter === 'learning' || filter === 'known' ? tips.filter((t) => t.status === filter) : tips;
}

export function countTips(tips) {
  const known = tips.filter((t) => t.status === 'known').length;
  return { all: tips.length, learning: tips.length - known, known };
}

// ------------------------------------------------------------ file format

// The shape written to tips.json, in schema order. "why" and "marks" are left out
// when empty. Marks are cleaned on the way out, which also copies them.
export function toStored(tip) {
  const out = { id: tip.id, where: tip.where, cat: tip.cat, rule: tip.rule };
  if (tip.why) out.why = tip.why;
  out.lat = tip.lat;
  out.lng = tip.lng;
  out.status = tip.status;
  out.createdAt = tip.createdAt;
  const marks = cleanMarks(tip.marks);
  if (marks.length) out.marks = marks;
  return out;
}

// With { marks: false }, two tips that differ only in what's drawn count as the same.
export function sameTip(a, b, { marks = true } = {}) {
  const stored = (tip) => toStored(marks ? tip : { ...tip, marks: [] });
  return JSON.stringify(stored(a)) === JSON.stringify(stored(b));
}

export function parseList(text) {
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    throw new TipsError("tips.json isn't valid JSON");
  }
  if (!Array.isArray(data)) throw new TipsError('tips.json should hold a list of tips: [ ... ]');
  return data;
}

export const serialiseList = (list) => `${JSON.stringify(list, null, 2)}\n`;

// Fetches the copy of tips.json the site is serving, skipping every cache.
export async function fetchTips({ url = 'tips.json', fetchImpl = globalThis.fetch } = {}) {
  const busted = `${url}${url.includes('?') ? '&' : '?'}v=${Date.now()}`;
  let res;
  try {
    res = await fetchImpl(busted, { cache: 'no-store' });
  } catch {
    throw new TipsError("Couldn't load tips.json. Check your connection.");
  }
  if (!res.ok) throw new TipsError(`Couldn't load tips.json (HTTP ${res.status}).`);
  return parseTips(parseList(await res.text()));
}

// ------------------------------------------------------------------ changes

// A change to the list. Saving re-applies it to whatever tips.json holds at that
// moment, so a retry after a conflict can't undo someone else's commit.
//   kind is for commit messages: add, draw, edit, move, pin, known, learning, delete.
//   withMarks says the change writes the tip's marks. Only drawing (or adding)
//   does; every other change keeps whatever marks the repo holds.
export const upsertOp = (tip, kind = 'edit') => ({
  type: 'upsert',
  kind,
  tip,
  withMarks: kind === 'draw' || kind === 'add',
});
export const deleteOp = (tip) => ({ type: 'delete', kind: 'delete', tip });

const hasId = (entry, id) => entry !== null && typeof entry === 'object' && entry.id === id;

const SCHEMA_KEYS = new Set(['id', 'where', 'cat', 'rule', 'why', 'lat', 'lng', 'status', 'createdAt', 'marks']);

// The entry that replaces an existing one. Unless the change writes marks, the
// repo's marks stay exactly as they are: a "Got it" made from a stale view, or by
// an older cached copy of the page, must never wipe a drawing. Keys this version
// doesn't know about are kept too, so fields a newer page adds survive this one.
function replaceEntry(existing, op) {
  const out = toStored(op.tip);
  if (!op.withMarks) {
    delete out.marks;
    if (Object.hasOwn(existing, 'marks')) out.marks = existing.marks;
  }
  // out only holds schema keys, so the extras can't clash with it. fromEntries
  // copies even an odd key like "__proto__" as plain data.
  const extra = Object.entries(existing).filter(([key]) => !SCHEMA_KEYS.has(key));
  return Object.fromEntries([...Object.entries(out), ...extra]);
}

// Applies a change to the raw tips.json array. Entries this page can't read are
// left exactly as they are rather than dropped.
export function applyOp(list, op) {
  const id = op.tip.id;
  if (op.type === 'delete') return list.filter((entry) => !hasId(entry, id));
  const at = list.findIndex((entry) => hasId(entry, id));
  if (at === -1) return [...list, toStored(op.tip)];
  return list.flatMap((entry, i) => (i === at ? [replaceEntry(entry, op)] : hasId(entry, id) ? [] : [entry]));
}

// text is tips.json as committed (null if the file doesn't exist yet).
export function applyOpToText(text, op) {
  return serialiseList(applyOp(text === null ? [] : parseList(text), op));
}

const COMMIT_VERBS = {
  add: 'Add tip',
  draw: 'Draw on map',
  edit: 'Edit tip',
  move: 'Move pin',
  pin: 'Pin tip',
  known: 'Got it',
  learning: 'Still learning',
  delete: 'Delete tip',
};

export function commitMessage(op) {
  const where = oneLine(op.tip.where);
  return `${COMMIT_VERBS[op.kind] ?? 'Update tip'}: ${where.length > 60 ? `${where.slice(0, 59)}…` : where}`;
}

// What "Save" copies when there's no token. One tip is plain JSON.
export function clipboardText(ops) {
  const upserts = ops.filter((op) => op.type === 'upsert').map((op) => toStored(op.tip));
  const deletes = ops.filter((op) => op.type === 'delete');
  if (upserts.length === 1 && deletes.length === 0) return JSON.stringify(upserts[0], null, 2);
  const parts = [];
  if (upserts.length) {
    parts.push(`Add or replace these in tips.json (match on id):\n${JSON.stringify(upserts, null, 2)}`);
  }
  if (deletes.length) {
    const lines = deletes.map((op) => `- id "${op.tip.id}" (${oneLine(op.tip.where)})`);
    parts.push(`Delete these from tips.json:\n${lines.join('\n')}`);
  }
  return parts.join('\n\n');
}

// ----------------------------------------------------- pending local changes

// Changes the page is holding on to, keyed by tip id. Only the latest change per
// tip is kept. Each entry is { op, state, at, commit?, error? } where state is:
//   saving     the commit is in flight
//   committed  it's in the repo; waiting for GitHub Pages to serve it
//   local      only on this device (no token, or the save failed)
const STATES = new Set(['saving', 'committed', 'local']);

// After this long, a committed change stops overriding what the site serves.
export const COMMITTED_TTL_MS = 30 * 60 * 1000;

// A change that doesn't write marks shows the served marks, since those are the
// ones the repo will keep.
export function mergePending(remote, pending) {
  const served = new Map(remote.map((tip) => [tip.id, tip]));
  const byId = new Map(served);
  for (const [id, { op }] of pending) {
    if (op.type === 'delete') byId.delete(id);
    else if (!op.withMarks && served.has(id)) byId.set(id, { ...op.tip, marks: served.get(id).marks });
    else byId.set(id, op.tip);
  }
  return [...byId.values()];
}

// A change that doesn't write marks has landed once everything else matches;
// otherwise a "Got it" that kept the repo's drawing would never count as served.
export function hasLanded(remote, op) {
  const served = remote.find((tip) => tip.id === op.tip.id);
  if (op.type === 'delete') return !served;
  return Boolean(served) && sameTip(served, op.tip, { marks: Boolean(op.withMarks) });
}

// Drops the changes the served file has caught up with, and committed ones that
// have waited too long. In-flight saves are left alone.
export function settlePending(remote, pending, now = Date.now()) {
  const next = new Map();
  const landed = [];
  const expired = [];
  for (const [id, entry] of pending) {
    if (entry.state === 'saving') next.set(id, entry);
    else if (hasLanded(remote, entry.op)) landed.push(entry);
    else if (entry.state === 'committed' && now - entry.at > COMMITTED_TTL_MS) expired.push(entry);
    else next.set(id, entry);
  }
  return { pending: next, landed, expired };
}

export function serialisePending(pending) {
  return JSON.stringify(
    [...pending.values()].map(({ op, ...rest }) => ({ ...rest, op: { ...op, tip: toStored(op.tip) } })),
  );
}

// Reads pending changes back from storage. A save that was in flight when the
// page closed may or may not have landed, so it comes back as local. Changes
// stored before withMarks existed get the default for their kind.
export function restorePending(text) {
  const pending = new Map();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return pending;
  }
  if (!Array.isArray(data)) return pending;
  for (const raw of data) {
    if (!raw || typeof raw !== 'object' || !raw.op) continue;
    const { type, kind } = raw.op;
    const tip = validateTip(raw.op.tip);
    if ((type !== 'upsert' && type !== 'delete') || !tip.ok || !STATES.has(raw.state)) continue;
    const op = type === 'upsert' ? upsertOp(tip.tip, typeof kind === 'string' ? kind : 'edit') : deleteOp(tip.tip);
    if (type === 'upsert' && typeof raw.op.withMarks === 'boolean') op.withMarks = raw.op.withMarks;
    const entry = {
      op,
      state: raw.state === 'saving' ? 'local' : raw.state,
      at: Number.isFinite(raw.at) ? raw.at : 0,
    };
    const { sha, url } = raw.commit ?? {};
    if (typeof sha === 'string' && typeof url === 'string' && url.startsWith('https://github.com/')) {
      entry.commit = { sha, url };
    }
    if (typeof raw.error === 'string') entry.error = raw.error;
    pending.set(tip.tip.id, entry);
  }
  return pending;
}

// --------------------------------------------------------------- the store

const PENDING_KEY = 'drivingRevision:pending:v1';
const SNAPSHOT_KEY = 'drivingRevision:snapshot:v1';

function storageGet(storage, key) {
  try {
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(storage, key, value) {
  try {
    storage?.setItem(key, value);
  } catch {
    // Private mode or storage full: the page still works, it just won't remember.
  }
}

// Holds the served tips plus local changes, and saves changes one at a time.
// Listeners get events: change, load-error, committed, save-error, settled.
export class TipStore {
  constructor({ url = 'tips.json', fetchImpl = (...args) => globalThis.fetch(...args), storage = null, pollMs = 15000, now = Date.now } = {}) {
    this.url = url;
    this.fetchImpl = fetchImpl;
    this.storage = storage;
    this.pollMs = pollMs; // null turns polling off
    this.now = now;
    // Set while a token is available: ({ update, message }) => Promise<{ changed, commit }>.
    this.commitText = null;
    this.remote = []; // tips as the site last served them
    this.rejected = []; // tips.json entries that failed validation
    this.loaded = false;
    this.loadError = null; // the last load's error, cleared by the next good load
    this.fromSnapshot = false;
    this.pending = restorePending(storageGet(storage, PENDING_KEY));
    this.listeners = new Set();
    this.queue = Promise.resolve();
    this.pollTimer = null;
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  emit(event) {
    for (const fn of this.listeners) fn(event);
  }

  // Every tip as it should look right now, numbered by createdAt.
  get tips() {
    return numberTips(mergePending(this.remote, this.pending));
  }

  entries(state) {
    return [...this.pending.values()].filter((entry) => entry.state === state);
  }

  isServed(id) {
    return this.remote.some((tip) => tip.id === id);
  }

  persist() {
    storageSet(this.storage, PENDING_KEY, serialisePending(this.pending));
  }

  settle() {
    const { pending, landed, expired } = settlePending(this.remote, this.pending, this.now());
    this.pending = pending;
    if (landed.length || expired.length) {
      this.persist();
      this.emit({ type: 'settled', landed, expired });
    }
  }

  // Loads tips.json from the site. If that fails on first load, falls back to
  // the last copy this device saw so the map isn't empty with no signal.
  async load() {
    try {
      const { tips, rejected } = await fetchTips({ url: this.url, fetchImpl: this.fetchImpl });
      this.remote = tips;
      this.rejected = rejected;
      this.loadError = null;
      this.fromSnapshot = false;
      storageSet(this.storage, SNAPSHOT_KEY, JSON.stringify(tips.map(toStored)));
    } catch (error) {
      if (!this.loaded) {
        try {
          this.remote = parseTips(JSON.parse(storageGet(this.storage, SNAPSHOT_KEY))).tips;
          this.fromSnapshot = true;
        } catch {
          // No usable snapshot either.
        }
      }
      this.loaded = true;
      this.loadError = error;
      this.emit({ type: 'load-error', error });
      this.emit({ type: 'change' });
      this.schedulePoll();
      return false;
    }
    this.loaded = true;
    this.settle();
    this.emit({ type: 'change' });
    this.schedulePoll();
    return true;
  }

  // Shows the change straight away, then commits it if there's a token.
  // Resolves with the pending entry (state "local" if it wasn't committed).
  save(op) {
    // Only the latest change per tip is kept, so a change made on top of a drawing
    // that isn't served yet must write that drawing too. Its tip came from the
    // merged view, so it already carries those marks.
    if (op.type === 'upsert' && !op.withMarks && this.pending.get(op.tip.id)?.op.withMarks) {
      op = { ...op, withMarks: true };
    }
    const entry = { op, state: this.commitText ? 'saving' : 'local', at: this.now() };
    this.pending.set(op.tip.id, entry);
    if (entry.state === 'local') this.settle(); // a change that undoes itself needs no saving
    this.persist();
    this.emit({ type: 'change' });
    return entry.state === 'saving' ? this.enqueue(entry) : Promise.resolve(entry);
  }

  // Commits everything that's only on this device. Needs a token.
  saveLocal() {
    if (!this.commitText) return Promise.resolve([]);
    const local = this.entries('local');
    for (const entry of local) Object.assign(entry, { state: 'saving', error: undefined });
    this.persist();
    this.emit({ type: 'change' });
    return Promise.all(local.map((entry) => this.enqueue(entry)));
  }

  // Throws away a change that hasn't been committed.
  discard(id) {
    if (this.pending.get(id)?.state !== 'local') return;
    this.pending.delete(id);
    this.persist();
    this.emit({ type: 'change' });
  }

  // Saves run one after another, so quick taps don't race each other for the file's sha.
  enqueue(entry) {
    const run = async () => {
      const commitText = this.commitText;
      const current = () => this.pending.get(entry.op.tip.id) === entry;
      try {
        if (!commitText) throw new Error('No GitHub token, so this change is only on this device.');
        const { changed, commit } = await commitText({
          update: (text) => applyOpToText(text, entry.op),
          message: commitMessage(entry.op),
        });
        Object.assign(entry, { state: 'committed', at: this.now(), commit: commit ?? undefined, error: undefined });
        if (current()) {
          this.settle();
          this.persist();
        }
        this.emit({ type: 'committed', entry, changed });
        this.emit({ type: 'change' });
        this.schedulePoll();
      } catch (error) {
        Object.assign(entry, { state: 'local', error: error.message });
        if (current()) this.persist();
        this.emit({ type: 'save-error', entry, error });
        this.emit({ type: 'change' });
      }
      return entry;
    };
    const result = this.queue.then(run);
    this.queue = result.catch(() => {});
    return result;
  }

  // While committed changes wait for GitHub Pages, re-fetch tips.json every so often.
  schedulePoll() {
    if (this.pollMs === null || this.pollTimer !== null || this.entries('committed').length === 0) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = null;
      this.load();
    }, this.pollMs);
  }

  stopPolling() {
    clearTimeout(this.pollTimer);
    this.pollTimer = null;
  }
}
