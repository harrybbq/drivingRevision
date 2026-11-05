// Works out where a turn-by-turn route goes, from OpenStreetMap street data:
// where each pair of consecutive streets meets, and the path along each street
// between those junctions. Pure functions: the page fetches the data and passes
// it in, so this runs the same in Node tests.

export const BBOX = Object.freeze([55.93, -4.805, 55.965, -4.72]); // Greenock: south, west, north, east

const GAP = 60; // metres: streets mapped this close count as meeting (e.g. split at a junction)
const SAME_PLACE = 25; // metres: a junction this close to where we joined is the one we came from

const EARTH = 6371000;
export function metres([lat1, lng1], [lat2, lng2]) {
  const rad = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * rad) / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(((lng2 - lng1) * rad) / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(a));
}

// "The Esplanade" and "Esplanade" are the same street.
const bare = (name) => String(name).replace(/^the\s+/i, '').trim().toLowerCase();
const regexEscape = (s) => s.replace(/[\\^$.|?*+()[\]{}"]/g, '\\$&');

// One Overpass request: every way on the route's streets, every roundabout,
// and anything named like a test centre, inside the Greenock box.
export function overpassQuery(steps, bbox = BBOX) {
  const names = [...new Set(steps.flatMap((s) => s.names))].map(regexEscape);
  const box = bbox.join(',');
  return [
    '[out:json][timeout:25];',
    '(',
    `  way["highway"]["name"~"^(The )?(${names.join('|')})$"](${box});`,
    `  way["highway"]["junction"~"^(roundabout|circular)$"](${box});`,
    ');',
    'out geom;',
    `nwr["name"~"test cent(re|er)",i](${box});`,
    'out center;',
  ].join('\n');
}

// ------------------------------------------------------------------ graph

function buildGraph(osm) {
  const ways = [];
  const nodes = new Map(); // "lat,lng" → { at: [lat, lng], ways: Set<way index> }
  let dtc = null;
  for (const el of osm?.elements ?? []) {
    const tags = el?.tags ?? {};
    if (el.type === 'way' && tags.highway && Array.isArray(el.geometry)) {
      const points = el.geometry.filter((p) => p && Number.isFinite(p.lat) && Number.isFinite(p.lon));
      if (points.length < 2) continue;
      // Ways share a node exactly where they join, so the coordinates identify it.
      const keys = points.map((p) => `${p.lat.toFixed(7)},${p.lon.toFixed(7)}`);
      const index = ways.length;
      const pos = new Map();
      keys.forEach((k, i) => pos.set(k, [...(pos.get(k) ?? []), i]));
      ways.push({
        names: [tags.name, tags.alt_name].filter(Boolean).map(bare),
        ring: /^(roundabout|circular)$/.test(tags.junction ?? ''),
        keys,
        pos,
      });
      points.forEach((p, i) => {
        if (!nodes.has(keys[i])) nodes.set(keys[i], { at: [p.lat, p.lon], ways: new Set() });
        nodes.get(keys[i]).ways.add(index);
      });
    } else if (!dtc && /test cent(re|er)/i.test(tags.name ?? '')) {
      const c = el.center ?? (Number.isFinite(el.lat) ? { lat: el.lat, lon: el.lon } : null);
      if (c) dtc = { at: [c.lat, c.lon], name: tags.name };
    }
  }

  // Roundabouts are often several ways; group the ones that touch.
  const ringOf = new Map(); // node key → roundabout id
  const wayRing = new Map();
  let id = 0;
  ways.forEach((w, start) => {
    if (!w.ring || wayRing.has(start)) return;
    const queue = [start];
    wayRing.set(start, id);
    while (queue.length) {
      for (const k of ways[queue.pop()].keys) {
        for (const other of nodes.get(k).ways) {
          if (ways[other].ring && !wayRing.has(other)) {
            wayRing.set(other, id);
            queue.push(other);
          }
        }
      }
    }
    id++;
  });
  for (const [wi, ring] of wayRing) for (const k of ways[wi].keys) ringOf.set(k, ring);

  const streetKeys = new Map(); // memo: bare name → Set of node keys
  return {
    ways, nodes, dtc, ringOf,
    keysOn(name) {
      const n = bare(name);
      if (!streetKeys.has(n)) {
        const set = new Set();
        ways.forEach((w) => { if (w.names.includes(n)) w.keys.forEach((k) => set.add(k)); });
        streetKeys.set(n, set);
      }
      return streetKeys.get(n);
    },
    at: (key) => nodes.get(key).at,
  };
}

// Roundabouts only go one way (the way's node order); streets are drawn either way.
function neighbours(g, key, allowed) {
  const out = [];
  for (const wi of g.nodes.get(key).ways) {
    const w = g.ways[wi];
    if (!allowed(w)) continue;
    const closed = w.keys[0] === w.keys.at(-1);
    for (const i of w.pos.get(key)) {
      const next = i + 1 < w.keys.length ? w.keys[i + 1] : closed ? w.keys[1] : null;
      const prev = i > 0 ? w.keys[i - 1] : closed ? w.keys.at(-2) : null;
      if (next) out.push(next);
      if (prev && !w.ring) out.push(prev);
    }
  }
  return out;
}

// Shortest path from one node to another using only the allowed ways. [lat, lng][] or null.
function shortest(g, from, to, allowed) {
  if (from === to) return [g.at(from)];
  const dist = new Map([[from, 0]]);
  const back = new Map();
  const heap = [[0, from]];
  const push = (item) => {
    heap.push(item);
    for (let i = heap.length - 1; i > 0;) {
      const p = (i - 1) >> 1;
      if (heap[p][0] <= heap[i][0]) break;
      [heap[p], heap[i]] = [heap[i], heap[p]];
      i = p;
    }
  };
  const pop = () => {
    const top = heap[0];
    const last = heap.pop();
    if (heap.length) {
      heap[0] = last;
      for (let i = 0; ;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
        if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
        if (m === i) break;
        [heap[m], heap[i]] = [heap[i], heap[m]];
        i = m;
      }
    }
    return top;
  };
  while (heap.length) {
    const [d, key] = pop();
    if (key === to) break;
    if (d > (dist.get(key) ?? Infinity)) continue;
    for (const next of neighbours(g, key, allowed)) {
      const nd = d + metres(g.at(key), g.at(next));
      if (nd < (dist.get(next) ?? Infinity)) {
        dist.set(next, nd);
        back.set(next, key);
        push([nd, next]);
      }
    }
  }
  if (!back.has(to)) return null;
  const path = [to];
  while (path.at(-1) !== from) path.push(back.get(path.at(-1)));
  return path.reverse().map((k) => g.at(k));
}

const pathLength = (path) => path.reduce((sum, p, i) => (i ? sum + metres(path[i - 1], p) : 0), 0);

// ---------------------------------------------------------------- junctions

// The candidate nearest to where we joined this street. When we're heading back
// onto the street we came from (a loop off it), skip the junction we came
// through: the two streets meet twice. At a crossroads the nearest one is right.
function choose(g, candidates, from, comingBack) {
  if (!from) return candidates[0];
  const d = (c) => metres(g.at(c.exit), g.at(from));
  const onward = comingBack ? candidates.filter((c) => d(c) > SAME_PLACE) : candidates;
  const pool = onward.length ? onward : candidates;
  return pool.reduce((best, c) => {
    const diff = d(c) - d(best);
    if (Math.abs(diff) > 1) return diff < 0 ? c : best;
    return pathLength(c.via) < pathLength(best.via) ? c : best;
  });
}

// Where street a meets street b: { exit, entry, via, approx }. exit is where we
// leave a and entry where we join b (the same node at an ordinary junction);
// via is the way round a roundabout between them.
function findJunction(g, a, b, from, comingBack) {
  const onA = g.keysOn(a);
  const onB = g.keysOn(b);
  const shared = [...onA].filter((k) => onB.has(k)).map((k) => ({ exit: k, entry: k, via: [], approx: false }));
  if (shared.length) return choose(g, shared, from, comingBack);

  const viaRing = [];
  for (const ka of onA) {
    const ring = g.ringOf.get(ka);
    if (ring === undefined) continue;
    for (const kb of onB) {
      if (g.ringOf.get(kb) !== ring) continue;
      const via = shortest(g, ka, kb, (w) => w.ring);
      if (via) viaRing.push({ exit: ka, entry: kb, via, approx: false });
    }
  }
  if (viaRing.length) return choose(g, viaRing, from, comingBack);

  let best = null;
  for (const ka of onA) {
    for (const kb of onB) {
      const d = metres(g.at(ka), g.at(kb));
      if (d <= GAP && (!best || d < best.d)) best = { exit: ka, entry: kb, via: [g.at(ka), g.at(kb)], approx: true, d };
    }
  }
  return best;
}

function nearestOn(g, name, point) {
  let best = null;
  for (const k of g.keysOn(name)) {
    const d = metres(g.at(k), point);
    if (!best || d < best.d) best = { key: k, d };
  }
  return best?.key ?? null;
}

// ------------------------------------------------------------------ solve

// steps: [{ road, direction, names }] (see route-data.js). Returns what to draw:
//   markers  [{ step, at, approx }]  where each row's instruction happens
//   lines    [{ step, path, approx }] the route, street by street
//   problems [{ step, message }]     what couldn't be placed
export function solveRoute(steps, osm) {
  const g = buildGraph(osm);
  const problems = [];
  const markers = [];
  const lines = [];

  // Streets in driving order. A name carried over from one row to the next
  // (Dalrymple St) is driven once.
  const seq = [];
  steps.forEach((step, i) => {
    for (const name of step.names) if (bare(seq.at(-1)?.name ?? '') !== bare(name)) seq.push({ name, step: i });
  });
  const missing = new Set(seq.filter((s) => g.keysOn(s.name).size === 0).map((s) => s.name));
  for (const name of missing) {
    problems.push({ step: seq.find((s) => s.name === name).step, message: `${name} isn't in the OpenStreetMap data for Greenock.` });
  }

  const start = g.dtc && !missing.has(seq[0]?.name) ? nearestOn(g, seq[0].name, g.dtc.at) : null;
  const end = g.dtc && seq.length && !missing.has(seq.at(-1).name) ? nearestOn(g, seq.at(-1).name, g.dtc.at) : null;

  // junctions[k] is where seq[k] meets seq[k + 1].
  const junctions = [];
  let from = start;
  for (let k = 0; k + 1 < seq.length; k++) {
    const a = seq[k].name;
    const b = seq[k + 1].name;
    const comingBack = k > 0 && bare(seq[k - 1].name) === bare(b);
    const j = missing.has(a) || missing.has(b) ? null : findJunction(g, a, b, from, comingBack);
    if (!j && !missing.has(a) && !missing.has(b)) {
      problems.push({ step: seq[k].step, message: `Couldn't find where ${a} meets ${b}.` });
    }
    junctions.push(j);
    from = j?.entry ?? null;
  }

  // The path along each street, from the junction where we join it to the one where we leave.
  seq.forEach((s, k) => {
    const joinAt = k === 0 ? start : junctions[k - 1]?.entry;
    const leaveAt = k === seq.length - 1 ? end : junctions[k]?.exit;
    if (joinAt && leaveAt) {
      const path = shortest(g, joinAt, leaveAt, (w) => w.ring || w.names.includes(bare(s.name)));
      lines.push(path ? { step: s.step, path, approx: false } : { step: s.step, path: [g.at(joinAt), g.at(leaveAt)], approx: true });
    }
    const j = junctions[k];
    if (j?.via.length > 1) lines.push({ step: s.step, path: j.via, approx: j.approx });
  });
  if (start) lines.unshift({ step: 0, path: [g.dtc.at, g.at(start)], approx: true });
  if (end) lines.push({ step: steps.length - 1, path: [g.at(end), g.dtc.at], approx: true });

  // Where each row's instruction happens: a single street's at the junction where
  // it ends; "A / B" at the junction of A and B.
  steps.forEach((step, i) => {
    let k = -1;
    if (step.names.length > 1) {
      const last = bare(step.names.at(-1));
      k = seq.findIndex((s, n) => n > 0 && s.step === i && bare(s.name) === last) - 1;
    } else if (step.names.length === 1) {
      k = seq.findIndex((s, n) => s.step === i && seq[n + 1] && seq[n + 1].step !== i);
    }
    const j = k >= 0 ? junctions[k] : null;
    if (j) markers.push({ step: i, at: g.at(j.exit), approx: j.approx });
    else if (i === 0 && g.dtc) markers.push({ step: 0, at: g.dtc.at, approx: false });
    else if (i === steps.length - 1 && end) markers.push({ step: i, at: g.at(end), approx: true });
  });

  return { dtc: g.dtc, markers, lines, problems };
}
