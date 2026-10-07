import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateTip, parseTips, fieldErrors, newTip, updateTip, numberTips, filterTips, countTips,
  toStored, sameTip, applyOp, applyOpToText, upsertOp, deleteOp, commitMessage, clipboardText,
  mergePending, settlePending, serialisePending, restorePending, fetchTips, TipStore,
  COMMITTED_TTL_MS, MARK_LIMITS, TipsError,
} from '../js/tips.js';

const base = {
  id: 'abc123',
  where: 'Test roundabout',
  cat: 'junction',
  rule: 'Left lane on approach',
  why: '',
  lat: 55.95,
  lng: -4.78,
  status: 'learning',
  createdAt: '2026-10-07T10:00:00.000Z',
};
const tip = (over = {}) => validateTip({ ...base, ...over }).tip;

test('validateTip keeps a good tip and normalises it', () => {
  const r = validateTip({ ...base, where: '  Test roundabout \r\n', lat: 55.1234567891, createdAt: '2026-10-07T11:00:00+01:00' });
  assert.equal(r.ok, true);
  assert.equal(r.tip.where, 'Test roundabout');
  assert.equal(r.tip.lat, 55.123457);
  assert.equal(r.tip.createdAt, '2026-10-07T10:00:00.000Z');
});

test('validateTip falls back rather than hiding the tip', () => {
  const t = tip({ cat: 'nonsense', status: 'maybe', why: 42 });
  assert.equal(t.cat, 'other');
  assert.equal(t.status, 'learning');
  assert.equal(t.why, '');
  assert.deepEqual([tip({ lng: null }).lat, tip({ lng: null }).lng], [null, null]);
  assert.deepEqual([tip({ lat: 91 }).lat, tip({ lat: '55' }).lat], [null, null]);
});

test('validateTip rejects entries it cannot use', () => {
  for (const bad of [
    null, [], 'x',
    { ...base, id: undefined }, { ...base, id: '<img src=x onerror=alert(1)>' }, { ...base, id: '' },
    { ...base, where: '   ' }, { ...base, rule: undefined }, { ...base, createdAt: 'yesterday' },
  ]) {
    assert.equal(validateTip(bad).ok, false, JSON.stringify(bad));
  }
});

test('parseTips reports bad and duplicate entries without throwing', () => {
  const { tips, rejected } = parseTips([base, { ...base }, { id: 'x' }]);
  assert.equal(tips.length, 1);
  assert.deepEqual(rejected.map((r) => r.index), [1, 2]);
  assert.match(rejected[0].reason, /duplicate/);
  assert.throws(() => parseTips({}), TipsError);
});

test('fieldErrors checks the form', () => {
  assert.deepEqual(fieldErrors({ where: 'A', cat: 'hill', rule: 'B' }), {});
  assert.deepEqual(Object.keys(fieldErrors({ where: ' ', cat: 'x', rule: '', why: 'y'.repeat(1001) })), ['where', 'cat', 'rule', 'why']);
});

test('newTip and updateTip', () => {
  const t = newTip({ where: 'A', cat: 'hill', rule: 'B' }, { ids: ['zzz'], now: new Date('2026-01-01T00:00:00Z') });
  assert.match(t.id, /^[a-z0-9]{8}$/);
  assert.equal(t.status, 'learning');
  assert.deepEqual([t.lat, t.lng], [null, null]);
  const moved = updateTip({ ...t, num: 4 }, { lat: 55.9, lng: -4.7, id: 'hijack', createdAt: '2000-01-01T00:00:00Z' });
  assert.equal(moved.id, t.id);
  assert.equal(moved.createdAt, t.createdAt);
  assert.equal(moved.lat, 55.9);
  assert.equal('num' in moved, false);
  assert.throws(() => updateTip(t, { rule: '' }), TipsError);
});

test('numbers follow createdAt and survive filtering', () => {
  const tips = numberTips([
    tip({ id: 'c', createdAt: '2026-03-01T00:00:00Z', status: 'known' }),
    tip({ id: 'a', createdAt: '2026-01-01T00:00:00Z' }),
    tip({ id: 'b', createdAt: '2026-02-01T00:00:00Z', status: 'known' }),
  ]);
  assert.deepEqual(tips.map((t) => [t.id, t.num]), [['a', 1], ['b', 2], ['c', 3]]);
  assert.deepEqual(filterTips(tips, 'known').map((t) => t.num), [2, 3]);
  assert.deepEqual(filterTips(tips, 'learning').map((t) => t.num), [1]);
  assert.equal(filterTips(tips, 'all').length, 3);
  assert.deepEqual(countTips(tips), { all: 3, learning: 1, known: 2 });
});

test('toStored writes schema order and drops an empty why', () => {
  assert.deepEqual(Object.keys(toStored(tip())), ['id', 'where', 'cat', 'rule', 'lat', 'lng', 'status', 'createdAt']);
  assert.deepEqual(Object.keys(toStored(tip({ why: 'Because' })))[4], 'why');
});

test('applyOp upserts in place, appends, deletes, and keeps entries it cannot read', () => {
  const unreadable = { id: 'weird', note: 'hand-edited' };
  const list = [toStored(tip({ id: 'a' })), unreadable, toStored(tip({ id: 'b' })), { id: 'a', dup: true }];
  const edited = applyOp(list, upsertOp(tip({ id: 'a', rule: 'New rule' })));
  assert.deepEqual(edited.map((e) => e.id), ['a', 'weird', 'b']);
  assert.equal(edited[0].rule, 'New rule');
  assert.equal(edited[1], unreadable);
  assert.deepEqual(applyOp(list, upsertOp(tip({ id: 'c' }), 'add')).map((e) => e.id), ['a', 'weird', 'b', 'a', 'c']);
  assert.deepEqual(applyOp(list, deleteOp(tip({ id: 'a' }))).map((e) => e.id), ['weird', 'b']);
});

test('applyOpToText creates the file, and refuses to overwrite broken JSON', () => {
  const text = applyOpToText(null, upsertOp(tip(), 'add'));
  assert.ok(text.endsWith('}\n]\n'));
  assert.equal(JSON.parse(text)[0].id, 'abc123');
  assert.equal(applyOpToText('[]\n', deleteOp(tip())), '[]\n');
  assert.throws(() => applyOpToText('[{', upsertOp(tip())), TipsError);
  assert.throws(() => applyOpToText('{}', upsertOp(tip())), TipsError);
});

test('commitMessage is one short line', () => {
  assert.equal(commitMessage(upsertOp(tip(), 'known')), 'Got it: Test roundabout');
  const long = commitMessage(upsertOp(tip({ where: `Line one\n${'x'.repeat(80)}` }), 'add'));
  assert.ok(!long.includes('\n'));
  assert.ok(long.length <= 'Add tip: '.length + 60);
});

test('clipboardText is plain JSON for one tip', () => {
  assert.deepEqual(JSON.parse(clipboardText([upsertOp(tip())])), toStored(tip()));
  const many = clipboardText([upsertOp(tip()), upsertOp(tip({ id: 'b' })), deleteOp(tip({ id: 'c' }))]);
  assert.match(many, /Add or replace/);
  assert.match(many, /- id "c"/);
});

test('mergePending overlays local changes', () => {
  const remote = [tip({ id: 'a' }), tip({ id: 'b' })];
  const pending = new Map([
    ['a', { op: upsertOp(tip({ id: 'a', status: 'known' })), state: 'committed', at: 0 }],
    ['b', { op: deleteOp(tip({ id: 'b' })), state: 'saving', at: 0 }],
    ['c', { op: upsertOp(tip({ id: 'c' })), state: 'local', at: 0 }],
  ]);
  assert.deepEqual(mergePending(remote, pending).map((t) => [t.id, t.status]), [['a', 'known'], ['c', 'learning']]);
});

test('settlePending drops what has landed or expired, never in-flight saves', () => {
  const now = 10 * COMMITTED_TTL_MS;
  const remote = [tip({ id: 'a', status: 'known' }), tip({ id: 'b' }), tip({ id: 's' })];
  const pending = new Map([
    ['a', { op: upsertOp(tip({ id: 'a', status: 'known' })), state: 'committed', at: now }], // served now
    ['b', { op: upsertOp(tip({ id: 'b', status: 'known' })), state: 'committed', at: now }], // not yet
    ['c', { op: deleteOp(tip({ id: 'c' })), state: 'committed', at: now }], // gone from served file
    ['d', { op: upsertOp(tip({ id: 'd' })), state: 'committed', at: now - COMMITTED_TTL_MS - 1 }], // waited too long
    ['e', { op: upsertOp(tip({ id: 'e' })), state: 'local', at: 0 }], // local never expires
    ['s', { op: deleteOp(tip({ id: 's' })), state: 'saving', at: 0 }],
  ]);
  const { pending: left, landed, expired } = settlePending(remote, pending, now);
  assert.deepEqual([...left.keys()], ['b', 'e', 's']);
  assert.deepEqual(landed.map((e) => e.op.tip.id), ['a', 'c']);
  assert.deepEqual(expired.map((e) => e.op.tip.id), ['d']);
});

test('pending changes survive a reload; in-flight ones come back as local', () => {
  const pending = new Map([
    ['a', { op: upsertOp(tip({ id: 'a' }), 'add'), state: 'saving', at: 5 }],
    ['b', { op: deleteOp(tip({ id: 'b' })), state: 'committed', at: 6, commit: { sha: 'f00', url: 'https://github.com/x/y/commit/f00' } }],
  ]);
  const back = restorePending(serialisePending(pending));
  assert.equal(back.get('a').state, 'local');
  assert.equal(back.get('a').op.kind, 'add');
  assert.equal(back.get('b').commit.sha, 'f00');
  const tampered = JSON.stringify([
    { op: { type: 'upsert', tip: { id: '<b>' } }, state: 'local', at: 1 },
    { op: { type: 'upsert', tip: toStored(tip({ id: 'ok' })) }, state: 'local', at: 1, commit: { sha: 'x', url: 'javascript:alert(1)' } },
  ]);
  const restored = restorePending(tampered);
  assert.deepEqual([...restored.keys()], ['ok']);
  assert.equal(restored.get('ok').commit, undefined);
  assert.equal(restorePending('not json').size, 0);
});

// -------------------------------------------------------------------- marks

const arrow = { type: 'arrow', points: [[55.95, -4.78], [55.951, -4.781]] };
const giveway = { type: 'giveway', points: [[55.95, -4.78], [55.9501, -4.7801]] };
const lane = { type: 'lane', dir: 'right', at: [55.95, -4.78] };
const label = { type: 'label', text: 'Signal here', at: [55.95, -4.78] };

test('validateTip keeps good marks, rounded, as fresh copies with only known keys', () => {
  const raw = {
    ...base,
    marks: [
      { type: 'arrow', points: [[55.1234567891, -4.1234567891], [55.2, -4.2]], colour: 'red' },
      { ...giveway }, { ...lane, extra: 1 }, { ...label },
    ],
  };
  const t = validateTip(raw).tip;
  assert.deepEqual(t.marks, [{ type: 'arrow', points: [[55.123457, -4.123457], [55.2, -4.2]] }, giveway, lane, label]);
  assert.notEqual(t.marks[1], raw.marks[1]);
  assert.notEqual(t.marks[1].points[0], raw.marks[1].points[0]);
  assert.deepEqual(tip().marks, []);
  for (const marks of [null, 'arrow', { 0: arrow }, 42]) assert.deepEqual(tip({ marks }).marks, []);
});

test('validateTip drops each bad mark on its own, never the tip', () => {
  const at = [55.95, -4.78];
  const bad = [
    null, 'arrow', [arrow], { points: arrow.points }, { type: 'circle', at },
    { type: 'arrow', points: [at] }, // too few points
    { type: 'arrow', points: [at, [91, -4.78]] },
    { type: 'arrow', points: [at, [55.95, -181]] },
    { type: 'arrow', points: [at, ['55.95', -4.78]] },
    { type: 'arrow', points: [at, [55.95, NaN]] },
    { type: 'arrow', points: [at, [55.95]] },
    { type: 'arrow', points: 'here' },
    { type: 'giveway', points: [at] },
    { type: 'giveway', points: [...giveway.points, at] }, // a bar is exactly two points
    { type: 'lane', dir: 'up', at },
    { type: 'lane', dir: 'left' },
    { type: 'lane', dir: 'left', at: { lat: 55.95, lng: -4.78 } },
    { type: 'label', text: ' \n ', at },
    { type: 'label', text: 42, at },
    { type: 'label', text: 'Hi', at: [Infinity, -4.78] },
  ];
  const r = validateTip({ ...base, marks: [arrow, ...bad, lane] });
  assert.equal(r.ok, true);
  assert.deepEqual(r.tip.marks, [arrow, lane]);
});

test('validateTip caps points, marks and label length', () => {
  const long = { type: 'arrow', points: Array.from({ length: 50 }, (_, i) => [55 + i / 100, -4.7]) };
  const [capped] = tip({ marks: [long] }).marks;
  assert.equal(capped.points.length, MARK_LIMITS.points);
  assert.deepEqual(capped.points.at(-1), [55.39, -4.7]); // the first 40 are kept

  const many = Array.from({ length: 35 }, (_, i) => ({ ...label, text: `Mark ${i}` }));
  const marks = tip({ marks: [null, ...many] }).marks;
  assert.equal(marks.length, MARK_LIMITS.marks);
  assert.deepEqual([marks[0].text, marks.at(-1).text], ['Mark 0', 'Mark 29']); // a bad mark doesn't use up a place

  const text = (t) => tip({ marks: [{ ...label, text: t }] }).marks[0].text;
  assert.equal(text('  Mirror,\n\t signal,   manoeuvre  '), 'Mirror, signal, manoeuvre');
  assert.equal(text('x'.repeat(60)), 'x'.repeat(MARK_LIMITS.label));
  assert.equal(text(`${'x'.repeat(39)} y`), 'x'.repeat(39)); // no space left dangling at the cut
  assert.equal(text(`${'x'.repeat(39)}🚗`), 'x'.repeat(39)); // nor half an emoji
  assert.equal(text('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>'); // plain text, escaped when shown
});

test('newTip starts with no marks; updateTip cleans the ones it is given', () => {
  const t = newTip({ where: 'A', cat: 'hill', rule: 'B' });
  assert.deepEqual(t.marks, []);
  const drawn = updateTip(t, { marks: [arrow, { type: 'nope' }, { ...lane, at: [55.1234567891, -4.78] }] });
  assert.deepEqual(drawn.marks, [arrow, { ...lane, at: [55.123457, -4.78] }]);
});

test('toStored writes marks last, only when there are some, as copies', () => {
  assert.equal('marks' in toStored(tip()), false);
  const t = tip({ why: 'Because', marks: [arrow, lane] });
  const stored = toStored(t);
  assert.deepEqual(Object.keys(stored).slice(-2), ['createdAt', 'marks']);
  assert.deepEqual(stored.marks, [arrow, lane]);
  stored.marks[0].points[0][0] = 0;
  assert.equal(t.marks[0].points[0][0], 55.95);
});

test('sameTip can ignore marks', () => {
  assert.equal(sameTip(tip(), tip({ marks: [arrow] })), false);
  assert.equal(sameTip(tip(), tip({ marks: [arrow] }), { marks: false }), true);
  assert.equal(sameTip(tip(), tip({ status: 'known' }), { marks: false }), false);
});

test('only drawing and adding write marks', () => {
  const kinds = ['add', 'draw', 'edit', 'move', 'pin', 'known', 'learning'];
  assert.deepEqual(kinds.map((kind) => upsertOp(tip(), kind).withMarks), [true, true, false, false, false, false, false]);
  assert.equal(upsertOp(tip()).withMarks, false);
  assert.equal(commitMessage(upsertOp(tip(), 'draw')), 'Draw on map: Test roundabout');
});

test('applyOp keeps the repo drawing unless the change is a drawing', () => {
  const repoMarks = [arrow, { type: 'roundabout', centre: [55.95, -4.78] }]; // includes a type from a newer page
  const list = [{ ...toStored(tip({ id: 'a' })), marks: repoMarks }, toStored(tip({ id: 'b' }))];

  // "Got it" from a copy that never saw the drawing.
  const [toggled] = applyOp(list, upsertOp(tip({ id: 'a', status: 'known' }), 'known'));
  assert.equal(toggled.status, 'known');
  assert.deepEqual(toggled.marks, repoMarks);
  assert.deepEqual(Object.keys(toggled).slice(-2), ['createdAt', 'marks']);
  // An edit from a view with different (stale) marks still keeps the repo's.
  const [edited] = applyOp(list, upsertOp(tip({ id: 'a', rule: 'New', marks: [lane] }), 'edit'));
  assert.equal(edited.rule, 'New');
  assert.deepEqual(edited.marks, repoMarks);
  // Nor does a tip with nothing drawn in the repo gain marks from a toggle.
  assert.equal('marks' in applyOp(list, upsertOp(tip({ id: 'b', marks: [lane] }), 'known'))[1], false);

  // Drawing replaces the marks, and clearing the drawing removes the key.
  assert.deepEqual(applyOp(list, upsertOp(tip({ id: 'a', marks: [lane] }), 'draw'))[0].marks, [lane]);
  assert.equal('marks' in applyOp(list, upsertOp(tip({ id: 'a' }), 'draw'))[0], false);
  // A new tip is written as it is.
  assert.deepEqual(applyOp(list, upsertOp(tip({ id: 'c', marks: [label] }), 'add'))[2].marks, [label]);
});

test('applyOp keeps keys a newer page added', () => {
  const list = [{ ...toStored(tip()), future: 1, marks: [arrow], later: { x: [1] } }];
  for (const kind of ['edit', 'known', 'draw']) {
    const [entry] = applyOp(list, upsertOp(tip({ rule: 'New', marks: [lane] }), kind));
    assert.equal(entry.rule, 'New');
    assert.deepEqual([entry.future, entry.later], [1, { x: [1] }]);
    assert.deepEqual(Object.keys(entry).slice(-3), ['marks', 'future', 'later']);
  }
  const odd = `[{"__proto__": {"x": 1}, ${JSON.stringify(toStored(tip())).slice(1)}]`;
  assert.deepEqual(JSON.parse(applyOpToText(odd, upsertOp(tip({ rule: 'New' }))))[0].__proto__, { x: 1 });
});

test('pending changes show, and settle on, the served marks unless they are a drawing', () => {
  const remote = [tip({ id: 'a', marks: [arrow] }), tip({ id: 'b' })];
  const pending = new Map([
    ['a', { op: upsertOp(tip({ id: 'a', status: 'known' }), 'known'), state: 'committed', at: 0 }],
    ['b', { op: upsertOp(tip({ id: 'b', marks: [lane] }), 'draw'), state: 'committed', at: 0 }],
    ['c', { op: upsertOp(tip({ id: 'c', marks: [label] })), state: 'local', at: 0 }], // not served: shown as it is
  ]);
  const shown = new Map(mergePending(remote, pending).map((t) => [t.id, t]));
  assert.equal(shown.get('a').status, 'known');
  assert.deepEqual(shown.get('a').marks, [arrow]);
  assert.deepEqual(shown.get('b').marks, [lane]);
  assert.deepEqual(shown.get('c').marks, [label]);

  // The toggle has landed though its copy had no marks; the drawing hasn't until they're served.
  const served = [tip({ id: 'a', status: 'known', marks: [arrow] }), tip({ id: 'b' })];
  assert.deepEqual(settlePending(served, pending, 0).landed.map((e) => e.op.tip.id), ['a']);
  served[1] = tip({ id: 'b', marks: [lane] });
  assert.deepEqual(settlePending(served, pending, 0).landed.map((e) => e.op.tip.id), ['a', 'b']);
});

test('withMarks survives a reload; older saves get the default for their kind', () => {
  const pending = new Map([
    ['a', { op: upsertOp(tip({ id: 'a', marks: [arrow] }), 'draw'), state: 'local', at: 1 }],
    ['b', { op: { ...upsertOp(tip({ id: 'b', marks: [lane] }), 'known'), withMarks: true }, state: 'committed', at: 2 }],
    ['c', { op: upsertOp(tip({ id: 'c' }), 'known'), state: 'local', at: 3 }],
    ['d', { op: deleteOp(tip({ id: 'd' })), state: 'local', at: 4 }],
  ]);
  const back = restorePending(serialisePending(pending));
  assert.deepEqual([...back.values()].map((e) => e.op), [...pending.values()].map((e) => e.op));

  const old = (kind, extra = {}) => ({ op: { type: 'upsert', kind, tip: toStored(tip({ id: kind })), ...extra }, state: 'local', at: 1 });
  const restored = restorePending(JSON.stringify([old('add'), old('draw'), old('edit'), old('pin', { withMarks: 'yes' })]));
  assert.deepEqual([...restored.values()].map((e) => [e.op.kind, e.op.withMarks]), [['add', true], ['draw', true], ['edit', false], ['pin', false]]);
});

test('fetchTips busts caches and validates', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push([url, init]);
    return { ok: true, status: 200, text: async () => JSON.stringify([base, { nope: 1 }]) };
  };
  const { tips, rejected } = await fetchTips({ url: 'tips.json', fetchImpl });
  assert.match(calls[0][0], /^tips\.json\?v=\d+$/);
  assert.equal(calls[0][1].cache, 'no-store');
  assert.equal(tips.length, 1);
  assert.equal(rejected.length, 1);
  await assert.rejects(fetchTips({ fetchImpl: async () => ({ ok: false, status: 404 }) }), /404/);
  await assert.rejects(fetchTips({ fetchImpl: async () => { throw new TypeError('offline'); } }), /connection/);
});

// ----------------------------------------------------------------- TipStore

function memoryStorage() {
  const map = new Map();
  return { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
}

function servedFile(initial) {
  const site = { text: JSON.stringify(initial), up: true };
  site.fetchImpl = async () => {
    if (!site.up) throw new TypeError('offline');
    return { ok: true, status: 200, text: async () => site.text };
  };
  return site;
}

test('store saves optimistically, commits, then settles when Pages catches up', async () => {
  const site = servedFile([toStored(tip({ id: 'a' }))]);
  let repoText = site.text;
  const store = new TipStore({ fetchImpl: site.fetchImpl, storage: memoryStorage(), pollMs: null });
  const events = [];
  store.subscribe((e) => events.push(e.type));
  await store.load();
  assert.equal(store.tips.length, 1);

  let release;
  const gate = new Promise((r) => { release = r; });
  store.commitText = async ({ update, message }) => {
    await gate;
    repoText = update(repoText);
    assert.equal(message, 'Got it: Test roundabout');
    return { changed: true, commit: { sha: 'c1', url: 'https://github.com/o/r/commit/c1' } };
  };
  const saving = store.save(upsertOp(tip({ id: 'a', status: 'known' }), 'known'));
  assert.equal(store.tips[0].status, 'known'); // shown before the commit lands
  assert.equal(store.pending.get('a').state, 'saving');
  release();
  const entry = await saving;
  assert.equal(entry.state, 'committed');
  assert.equal(entry.commit.sha, 'c1');

  await store.load(); // Pages still serving the old file: keep the local copy
  assert.equal(store.tips[0].status, 'known');
  assert.equal(store.pending.size, 1);

  site.text = repoText; // Pages redeployed
  await store.load();
  assert.equal(store.pending.size, 0);
  assert.equal(store.tips[0].status, 'known');
  assert.ok(events.includes('committed') && events.includes('settled'));
});

test('store runs saves one at a time, in order', async () => {
  const site = servedFile([]);
  let repoText = '[]\n';
  const order = [];
  const store = new TipStore({ fetchImpl: site.fetchImpl, storage: memoryStorage(), pollMs: null });
  await store.load();
  let active = 0;
  store.commitText = async ({ update, message }) => {
    active++;
    assert.equal(active, 1, 'two commits overlapped');
    await new Promise((r) => setTimeout(r, 5));
    repoText = update(repoText);
    order.push(message);
    active--;
    return { changed: true, commit: { sha: 's', url: 'https://github.com/o/r/commit/s' } };
  };
  await Promise.all([
    store.save(upsertOp(tip({ id: 'a', where: 'One' }), 'add')),
    store.save(upsertOp(tip({ id: 'b', where: 'Two' }), 'add')),
    store.save(upsertOp(tip({ id: 'a', where: 'One', status: 'known' }), 'known')),
  ]);
  assert.deepEqual(order, ['Add tip: One', 'Add tip: Two', 'Got it: One']);
  assert.deepEqual(JSON.parse(repoText).map((t) => [t.id, t.status]), [['a', 'known'], ['b', 'learning']]);
});

test('store keeps a failed save on the device and can retry it', async () => {
  const site = servedFile([]);
  const storage = memoryStorage();
  const store = new TipStore({ fetchImpl: site.fetchImpl, storage, pollMs: null });
  await store.load();
  store.commitText = async () => { throw new Error('GitHub said no'); };
  const errors = [];
  store.subscribe((e) => e.type === 'save-error' && errors.push(e.error.message));
  const entry = await store.save(upsertOp(tip({ id: 'n' }), 'add'));
  assert.equal(entry.state, 'local');
  assert.equal(entry.error, 'GitHub said no');
  assert.deepEqual(errors, ['GitHub said no']);
  assert.equal(store.tips.length, 1);

  const reopened = new TipStore({ fetchImpl: site.fetchImpl, storage, pollMs: null });
  assert.equal(reopened.pending.get('n').state, 'local');
  reopened.commitText = async () => ({ changed: true, commit: { sha: 'ok', url: 'https://github.com/o/r/commit/ok' } });
  const [retried] = await reopened.saveLocal();
  assert.equal(retried.state, 'committed');
});

test('store without a token keeps changes local, and discard drops them', async () => {
  const site = servedFile([toStored(tip({ id: 'a' }))]);
  const store = new TipStore({ fetchImpl: site.fetchImpl, storage: memoryStorage(), pollMs: null });
  await store.load();
  const entry = await store.save(upsertOp(tip({ id: 'a', rule: 'Changed' })));
  assert.equal(entry.state, 'local');
  assert.equal(store.tips[0].rule, 'Changed');
  store.discard('a');
  assert.equal(store.tips[0].rule, 'Left lane on approach');
  await store.save(upsertOp(tip({ id: 'a' }))); // same as served: nothing to keep
  assert.equal(store.pending.size, 0);
});

test('store falls back to the last copy it saw when offline', async () => {
  const site = servedFile([toStored(tip({ id: 'a' }))]);
  const storage = memoryStorage();
  await new TipStore({ fetchImpl: site.fetchImpl, storage, pollMs: null }).load();
  site.up = false;
  const offline = new TipStore({ fetchImpl: site.fetchImpl, storage, pollMs: null });
  const errors = [];
  offline.subscribe((e) => e.type === 'load-error' && errors.push(e.error));
  assert.equal(await offline.load(), false);
  assert.equal(offline.fromSnapshot, true);
  assert.match(offline.loadError.message, /connection/);
  assert.equal(offline.tips.length, 1);
  assert.equal(errors.length, 1);
});

test('store polls while a commit waits for Pages, then stops', async () => {
  const site = servedFile([]);
  let fetches = 0;
  const counting = async (...args) => { fetches++; return site.fetchImpl(...args); };
  const store = new TipStore({ fetchImpl: counting, storage: memoryStorage(), pollMs: 5 });
  await store.load();
  let repoText = '[]\n';
  store.commitText = async ({ update }) => {
    repoText = update(repoText);
    return { changed: true, commit: { sha: 's', url: 'https://github.com/o/r/commit/s' } };
  };
  await store.save(upsertOp(tip({ id: 'p' }), 'add'));
  await new Promise((r) => setTimeout(r, 30));
  assert.ok(fetches >= 3, `polled ${fetches - 1} times`);
  site.text = repoText;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(store.pending.size, 0);
  const settledAt = fetches;
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(fetches, settledAt, 'kept polling after settling');
  store.stopPolling();
});

const commitInto = (repo) => async ({ update }) => {
  repo.text = update(repo.text);
  return { changed: true, commit: { sha: 's', url: 'https://github.com/o/r/commit/s' } };
};

test('store: a toggle on top of an unsaved drawing commits the drawing too', async () => {
  const site = servedFile([toStored(tip({ id: 'a' }))]);
  const store = new TipStore({ fetchImpl: site.fetchImpl, storage: memoryStorage(), pollMs: null });
  await store.load();
  await store.save(upsertOp(updateTip(store.tips[0], { marks: [arrow] }), 'draw')); // no token: kept on this device
  assert.deepEqual(store.tips[0].marks, [arrow]);

  const toggle = upsertOp(updateTip(store.tips[0], { status: 'known' }), 'known');
  const entry = await store.save(toggle);
  assert.equal(toggle.withMarks, false); // the caller's op is left alone
  assert.equal(entry.op.withMarks, true);
  assert.equal(store.pending.get('a').op.withMarks, true);
  assert.deepEqual(store.tips[0].marks, [arrow]);

  const repo = { text: site.text };
  store.commitText = commitInto(repo);
  await store.saveLocal();
  const [saved] = JSON.parse(repo.text);
  assert.equal(saved.status, 'known');
  assert.deepEqual(saved.marks, [arrow]);
});

test('store: a committed toggle settles once served, though the repo has marks its copy lacked', async () => {
  const site = servedFile([toStored(tip({ id: 'a' }))]);
  const store = new TipStore({ fetchImpl: site.fetchImpl, storage: memoryStorage(), pollMs: null });
  await store.load();
  const repo = { text: JSON.stringify([{ ...toStored(tip({ id: 'a' })), marks: [arrow] }]) }; // drawn on another device
  store.commitText = commitInto(repo);
  const entry = await store.save(upsertOp(updateTip(store.tips[0], { status: 'known' }), 'known'));
  assert.equal(entry.state, 'committed');
  assert.deepEqual(JSON.parse(repo.text)[0].marks, [arrow]);

  site.text = repo.text; // Pages redeployed
  await store.load();
  assert.equal(store.pending.size, 0);
  assert.equal(store.tips[0].status, 'known');
  assert.deepEqual(store.tips[0].marks, [arrow]);
});
