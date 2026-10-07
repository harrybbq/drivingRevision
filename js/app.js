// The map page: wires the tip store, the map, the panel (list / detail / form /
// pin prompts) and the settings dialog together. All data goes into the page as
// text through h() from dom.js.

import { REPO } from './config.js';
import {
  TipStore, FILTERS, CATEGORIES, LIMITS, categoryLabel, countTips, filterTips, isPinned,
  fieldErrors, newTip, updateTip, sameTip, upsertOp, deleteOp, clipboardText,
} from './tips.js';
import { readToken, saveToken, forgetToken, commitTextFile, checkToken, tokenKind } from './github.js';
import { h, icon, toast, copyText, safeStorage } from './dom.js';
import { TipMap, locate } from './map.js';
import { Sheet } from './sheet.js';

const $ = (id) => document.getElementById(id);
const els = {
  panel: $('panel'),
  grab: $('panel-grab'),
  body: $('panel-body'),
  mapEl: $('map'),
  mapWrap: $('map-wrap'),
  mapActions: $('map-actions'),
  locateBtn: $('locate-btn'),
  dropBtn: $('drop-btn'),
  settingsBtn: $('settings-btn'),
  toasts: $('toasts'),
  settings: $('settings-dialog'),
  tokenForm: $('token-form'),
  tokenInput: $('token-input'),
  tokenStatus: $('token-status'),
  copyDialog: $('copy-dialog'),
  copyBox: $('copy-text'),
};
for (const slot of document.querySelectorAll('.js-icon')) slot.replaceWith(icon(slot.dataset.icon));

const storage = safeStorage();
const FILTER_KEY = 'drivingRevision:filter';
const store = new TipStore({ storage });

// What the panel is showing:
//   list | detail (selectedId) | form (form) | place (mode: new or pin) | move (mode)
const ui = {
  view: 'list',
  filter: readFilter(),
  selectedId: null,
  confirm: null, // 'delete' | 'discard' while the detail view asks to confirm
  form: null, // { id: string|null, lat, lng }
  mode: null, // { kind: 'new' } | { kind: 'pin', id } | { kind: 'move', id }
};
let lastView = null;
let focusNext = null; // data-key to focus after the next panel render

const sheet = new Sheet(els.panel, els.grab, {
  onChange: (state) => els.mapActions.classList.toggle('is-hidden', state === 'full'),
});

let map = null;
if (globalThis.L) {
  map = new TipMap(els.mapEl, els.mapWrap, { onSelect: (id) => openTip(id) });
} else {
  els.mapEl.append(h('p', { class: 'map-fallback' }, "The map couldn't load (no connection?). Your tips are still in the list."));
  els.mapActions.hidden = true;
}

// ------------------------------------------------------------- helpers

function readFilter() {
  try {
    const saved = storage?.getItem(FILTER_KEY);
    return FILTERS.some((f) => f.key === saved) ? saved : 'all';
  } catch {
    return 'all';
  }
}

const findTip = (id) => store.tips.find((t) => t.id === id) ?? null;
const hasToken = () => store.commitText !== null;
const formatDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function badge(tip) {
  return h('span', { class: 'badge', 'aria-hidden': 'true' }, h('span', {}, String(tip.num)));
}

function stateLine(entry) {
  if (!entry) return null;
  if (entry.state === 'saving') return h('span', { class: 'state' }, 'Saving to GitHub…');
  if (entry.state === 'committed') return h('span', { class: 'state' }, 'Saved · site updates in about a minute');
  return h('span', { class: 'state state-local' }, 'Only on this device');
}

function notify(message, options) {
  toast(els.toasts, message, options);
}

// Copies inside the click that caused it (browsers only allow that), or shows the text to copy by hand.
function copyOrShow(text, done, doneOptions) {
  copyText(text).then((ok) => {
    if (ok) {
      if (done) notify(done, doneOptions);
      return;
    }
    els.copyBox.value = text;
    els.copyDialog.showModal();
    els.copyBox.select();
  });
}

// ---------------------------------------------------------------- saving

// Every change goes through here. With a token it's committed, so every device
// sees it; without one it stays on this device and is copied as JSON for Claude.
function save(op) {
  if (!hasToken() && (op.type === 'upsert' || store.isServed(op.tip.id))) {
    copyOrShow(clipboardText([op]), 'Saved on this device only. Copied as JSON for Claude.', {
      action: { label: 'Save everywhere', onClick: openSettings },
      ms: 8000,
    });
  }
  return store.save(op);
}

// Pushes changes that are only on this device, once there's a token to do it with.
function syncLocal() {
  const waiting = store.entries('local').length;
  if (!hasToken() || !waiting || navigator.onLine === false) return;
  notify(`Saving ${plural(waiting, 'change', 'changes')} from this device to GitHub…`);
  store.saveLocal();
}

store.subscribe((event) => {
  if (event.type === 'change') {
    renderAll();
  } else if (event.type === 'committed') {
    const url = event.entry.commit?.url;
    notify(
      event.changed ? 'Saved to GitHub. The live site updates in about a minute.' : 'Already saved on GitHub.',
      { action: url?.startsWith('https://github.com/') ? { label: 'View commit', href: url } : null },
    );
  } else if (event.type === 'save-error') {
    const auth = [401, 403, 404].includes(event.error.status);
    notify(`Couldn't save to GitHub. ${event.error.message} The change is kept on this device.`, {
      error: true,
      ms: 10000,
      action: auth ? { label: 'Settings', onClick: openSettings } : null,
    });
  } else if (event.type === 'settled') {
    if (event.landed.some((entry) => entry.state === 'committed')) notify('The live site has caught up with your changes.');
  }
});

// ------------------------------------------------------------- rendering

function renderAll() {
  const tips = store.tips;
  const localIds = new Set(store.entries('local').map((e) => e.op.tip.id));
  if (map) {
    const visible = filterTips(tips, ui.filter);
    const selected = tips.find((t) => t.id === ui.selectedId);
    map.render(selected && !visible.includes(selected) ? [...visible, selected] : visible, ui.selectedId, localIds);
  }
  renderSettingsBadge(localIds.size);
  if (ui.view === 'list' || ui.view === 'detail') renderPanel();
}

// The settings button shows how many changes haven't reached GitHub, else a dot when a token is set.
function renderSettingsBadge(waiting) {
  const count = els.settingsBtn.querySelector('.count');
  count.textContent = String(waiting);
  count.hidden = waiting === 0;
  els.settingsBtn.querySelector('.dot').hidden = waiting > 0 || !hasToken();
  els.settingsBtn.setAttribute(
    'aria-label',
    waiting ? `Settings: ${plural(waiting, 'change', 'changes')} only on this device` : 'Settings: save to GitHub',
  );
}

function renderPanel() {
  const body = els.body;
  const sameView = lastView === ui.view;
  const scroll = body.scrollTop;
  const active = document.activeElement;
  const focusKey = focusNext ?? (body.contains(active) ? active.closest('[data-key]')?.dataset.key : null);
  focusNext = null;
  const view = { list: listView, detail: detailView, form: formView, place: placeView, move: moveView }[ui.view];
  body.replaceChildren(view());
  lastView = ui.view;
  body.scrollTop = sameView ? scroll : 0;
  if (focusKey) body.querySelector(`[data-key="${CSS.escape(focusKey)}"]`)?.focus({ preventScroll: sameView });
  if (ui.view === 'place' || ui.view === 'move') {
    // Size the sheet to the prompt itself (the scroll box is never shorter than the sheet).
    const style = getComputedStyle(body);
    const content = body.firstElementChild.getBoundingClientRect().height + parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
    sheet.fit(content + els.grab.offsetHeight - 6 + 3);
  }
}

// ---------------------------------------------------------------- list

function listView() {
  const tips = store.tips;
  const counts = countTips(tips);
  const visible = filterTips(tips, ui.filter);
  return h(
    'div',
    {},
    h(
      'div',
      { class: 'filters', role: 'group', 'aria-label': 'Show' },
      FILTERS.map((f) =>
        h(
          'button',
          { type: 'button', 'aria-pressed': String(ui.filter === f.key), 'data-key': `filter-${f.key}`, onclick: () => setFilter(f.key) },
          f.label,
          h('span', { class: 'count' }, String(counts[f.key])),
        ),
      ),
    ),
    listNotices(),
    visible.length ? h('ul', { class: 'tips' }, visible.map(tipRow)) : emptyState(counts),
  );
}

function listNotices() {
  const notices = [];
  if (store.loadError) {
    notices.push(
      h(
        'div',
        { class: 'notice notice-warn', role: 'alert' },
        h('p', {}, store.fromSnapshot
          ? `${store.loadError.message} Showing the last copy this device saw.`
          : store.loadError.message),
        h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn', onclick: () => store.load() }, 'Try again')),
      ),
    );
  }
  if (store.rejected.length) {
    const first = store.rejected[0];
    notices.push(
      h('div', { class: 'notice notice-warn' },
        h('p', {}, `${plural(store.rejected.length, 'entry', 'entries')} in tips.json couldn't be read, so ${store.rejected.length === 1 ? "it's" : "they're"} hidden. Entry ${first.index + 1}: ${first.reason}.`)),
    );
  }
  const local = store.entries('local');
  if (local.length) {
    notices.push(
      h(
        'div',
        { class: 'notice notice-local' },
        h('p', {}, `${plural(local.length, 'change is', 'changes are')} only on this device. Other devices won't see ${local.length === 1 ? 'it' : 'them'} until ${local.length === 1 ? "it's" : "they're"} saved to GitHub.`),
        h(
          'div',
          { class: 'btn-row' },
          hasToken()
            ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => store.saveLocal() }, icon('upload'), 'Save to GitHub')
            : h('button', { type: 'button', class: 'btn btn-primary', onclick: openSettings }, icon('upload'), 'Save everywhere'),
          h('button', { type: 'button', class: 'btn', onclick: () => copyOrShow(clipboardText(local.map((e) => e.op)), 'Copied as JSON. Paste it to Claude to commit it.') }, icon('copy'), 'Copy as JSON'),
        ),
      ),
    );
  }
  return notices;
}

function emptyState(counts) {
  if (!store.loaded) return h('p', { class: 'empty' }, 'Loading tips…');
  if (counts.all === 0) {
    return h('div', { class: 'empty' },
      h('p', {}, 'No tips yet.'),
      h('p', {}, map ? 'Tap “Drop a pin”, then tap the map where your instructor gave you the tip.' : ''));
  }
  const label = FILTERS.find((f) => f.key === ui.filter).label;
  return h('div', { class: 'empty' }, h('p', {}, `Nothing under “${label}”.`));
}

function tipRow(tip) {
  const known = tip.status === 'known';
  const entry = store.pending.get(tip.id);
  const pinned = isPinned(tip);
  return h(
    'li',
    { class: `tip cat-${tip.cat}${known ? ' is-known' : ''}${tip.id === ui.selectedId ? ' is-selected' : ''}`, 'data-id': tip.id },
    h(
      'button',
      { type: 'button', class: 'tip-main', 'data-key': `open-${tip.id}`, onclick: () => openTip(tip.id) },
      badge(tip),
      h(
        'span',
        { class: 'tip-text' },
        h('span', { class: 'visually-hidden' }, `Tip ${tip.num}${known ? ', got it' : ''}: `),
        h('span', { class: 'label' }, categoryLabel(tip.cat)),
        h('span', { class: 'tip-where' }, tip.where),
        h('span', { class: 'tip-rule' }, tip.rule),
      ),
    ),
    h(
      'button',
      { type: 'button', class: 'check', 'aria-pressed': String(known), 'aria-label': `Got it: tip ${tip.num}`, title: 'Got it', 'data-key': `check-${tip.id}`, onclick: () => toggleKnown(tip.id) },
      h('span', {}, icon('check')),
    ),
    (!pinned || entry) &&
      h(
        'div',
        { class: 'tip-extra' },
        !pinned && h('span', { class: 'chip' }, 'Not pinned yet'),
        !pinned && map && h('button', { type: 'button', class: 'btn btn-quiet', 'data-key': `pin-${tip.id}`, onclick: () => startPin(tip.id) }, icon('pin'), 'Pin on map'),
        stateLine(entry),
      ),
  );
}

// -------------------------------------------------------------- detail

function detailView() {
  const tip = findTip(ui.selectedId);
  if (!tip) {
    ui.view = 'list';
    ui.selectedId = null;
    return listView();
  }
  const known = tip.status === 'known';
  const pinned = isPinned(tip);
  const entry = store.pending.get(tip.id);
  const action = (label, iconName, onclick, extra = {}) =>
    h('button', { type: 'button', class: 'btn', onclick, ...extra }, icon(iconName), label);

  return h(
    'article',
    { class: `detail cat-${tip.cat}${known ? ' is-known' : ''}`, 'data-id': tip.id, 'aria-labelledby': 'detail-title' },
    h('div', { class: 'view-head' },
      h('button', { type: 'button', class: 'btn btn-quiet back', 'data-key': 'back', onclick: backToList }, icon('back'), 'All tips'),
      stateLine(entry)),
    h('div', { class: 'detail-title' },
      badge(tip),
      h('div', {},
        h('span', { class: 'label' }, `Tip ${tip.num} · ${categoryLabel(tip.cat)}`),
        h('h2', { id: 'detail-title' }, tip.where))),
    h('p', { class: 'detail-rule' }, tip.rule),
    tip.why && h('div', { class: 'detail-why' }, h('span', { class: 'label' }, 'Why'), h('p', {}, tip.why)),
    h(
      'button',
      { type: 'button', class: 'toggle-known', 'aria-pressed': String(known), 'data-key': 'toggle-known', onclick: () => toggleKnown(tip.id) },
      h('span', { class: 'check-mark' }, icon('check')),
      h('span', {}, 'Got it', h('small', {}, known ? 'Faded on the map. Tap to mark as still learning.' : 'Tick when you can do this without thinking.')),
    ),
    !pinned && h('div', { class: 'notice' },
      h('p', {}, 'Not pinned yet. Pin it to see it on the map.'),
      map && h('div', { class: 'btn-row' }, h('button', { type: 'button', class: 'btn btn-primary', 'data-key': 'pin', onclick: () => startPin(tip.id) }, icon('pin'), 'Pin on map'))),
    entry?.state === 'local' && localNotice(tip, entry),
    ui.confirm === 'delete'
      ? h('div', { class: 'confirm', role: 'group', 'aria-label': 'Confirm delete' },
          h('p', {}, `Delete tip ${tip.num}, “${tip.where}”? This can't be undone.`),
          h('div', { class: 'btn-row' },
            h('button', { type: 'button', class: 'btn', 'data-key': 'cancel-delete', onclick: () => setConfirm(null, 'delete') }, 'Keep it'),
            h('button', { type: 'button', class: 'btn btn-danger-solid', 'data-key': 'confirm-delete', onclick: () => removeTip(tip.id) }, 'Delete tip')))
      : h('div', { class: 'btn-row' },
          action('Edit', 'edit', () => openEditForm(tip.id), { 'data-key': 'edit' }),
          pinned && map && action('Move pin', 'move', () => startMove(tip.id), { 'data-key': 'move' }),
          action('Delete', 'trash', () => setConfirm('delete', 'cancel-delete'), { class: 'btn btn-danger', 'data-key': 'delete' })),
    h('p', { class: 'meta' }, `Added ${formatDate(tip.createdAt)}`),
  );
}

function localNotice(tip, entry) {
  return h(
    'div',
    { class: 'notice notice-local' },
    h('p', {}, entry.error ? `Not saved to GitHub: ${entry.error}` : "This change is only on this device. Other devices won't see it yet."),
    ui.confirm === 'discard'
      ? h('div', { class: 'btn-row' },
          h('button', { type: 'button', class: 'btn', 'data-key': 'cancel-discard', onclick: () => setConfirm(null, 'discard') }, 'Keep change'),
          h('button', { type: 'button', class: 'btn btn-danger-solid', onclick: () => discardChange(tip.id) }, 'Discard change'))
      : h('div', { class: 'btn-row' },
          hasToken() && h('button', { type: 'button', class: 'btn btn-primary', onclick: () => store.saveLocal() }, icon('upload'), 'Save to GitHub'),
          h('button', { type: 'button', class: 'btn', onclick: () => copyOrShow(clipboardText([entry.op]), 'Copied as JSON.') }, icon('copy'), 'Copy as JSON'),
          h('button', { type: 'button', class: 'btn btn-danger', 'data-key': 'discard', onclick: () => setConfirm('discard', 'cancel-discard') }, 'Discard')),
  );
}

function setConfirm(kind, focusKey) {
  ui.confirm = kind;
  focusNext = focusKey;
  renderPanel();
}

// ---------------------------------------------------------------- form

function formView() {
  const editing = ui.form.id ? findTip(ui.form.id) : null;
  const values = editing ?? { where: '', cat: '', rule: '', why: '' };
  const errorEl = (name) => h('p', { class: 'error', id: `err-${name}`, hidden: true });
  const pinned = ui.form.lat !== null && ui.form.lat !== undefined;

  return h(
    'form',
    { class: 'form', id: 'tip-form', novalidate: true, onsubmit: submitForm },
    h('div', { class: 'view-head' },
      h('button', { type: 'button', class: 'btn btn-quiet back', 'data-key': 'back', onclick: cancelForm }, icon('back'), 'Cancel')),
    h('h2', {}, editing ? `Edit tip ${editing.num}` : 'New tip'),
    h('div', { class: 'field' },
      h('label', { for: 'f-where' }, 'Where'),
      h('input', { id: 'f-where', name: 'where', type: 'text', maxlength: LIMITS.where, value: values.where, autocomplete: 'off', 'aria-describedby': 'err-where', placeholder: 'Road, junction or landmark' }),
      errorEl('where')),
    h('fieldset', { class: 'field', 'aria-describedby': 'err-cat' },
      h('legend', {}, 'Category'),
      h('div', { class: 'cats' },
        CATEGORIES.map((c) =>
          h('div', { class: `cat-option cat-${c.key}` },
            h('input', { type: 'radio', name: 'cat', id: `f-cat-${c.key}`, value: c.key, checked: values.cat === c.key }),
            h('label', { for: `f-cat-${c.key}` }, c.label)))),
      errorEl('cat')),
    h('div', { class: 'field' },
      h('label', { for: 'f-rule' }, 'What to do'),
      h('textarea', { id: 'f-rule', name: 'rule', rows: 4, maxlength: LIMITS.rule, 'aria-describedby': 'hint-rule err-rule' }, values.rule),
      h('p', { class: 'hint', id: 'hint-rule' }, 'Put it in routine order if it helps: MSPSpG, Mirror, Signal, Position, Speed, Gear.'),
      errorEl('rule')),
    h('div', { class: 'field' },
      h('label', { for: 'f-why' }, 'Why ', h('span', { class: 'opt' }, '(optional)')),
      h('textarea', { id: 'f-why', name: 'why', rows: 3, maxlength: LIMITS.why, 'aria-describedby': 'err-why', placeholder: 'What goes wrong if you don’t' }, values.why ?? ''),
      errorEl('why')),
    !editing && h('p', { class: 'hint' }, pinned
      ? 'Pinned where you tapped. You can move it later.'
      : 'Not pinned. You can pin it on the map after saving.'),
    h('div', { class: 'btn-row' },
      h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save'),
      h('button', { type: 'button', class: 'btn', onclick: cancelForm }, 'Cancel')),
    !hasToken() && h('p', { class: 'hint' }, 'No GitHub token on this device: Save keeps the tip here and copies it as JSON, ready to paste to Claude.'),
  );
}

function showErrors(form, errors) {
  for (const name of ['where', 'cat', 'rule', 'why']) {
    const message = errors[name];
    const err = form.querySelector(`#err-${name}`);
    err.textContent = message ?? '';
    err.hidden = !message;
    const fields = name === 'cat' ? form.querySelectorAll('input[name="cat"]') : [form.elements[name]];
    for (const field of fields) {
      if (message) field.setAttribute('aria-invalid', 'true');
      else field.removeAttribute('aria-invalid');
    }
  }
  const first = ['where', 'cat', 'rule', 'why'].find((n) => errors[n]);
  if (first) (first === 'cat' ? form.querySelector('input[name="cat"]') : form.elements[first]).focus();
}

function submitForm(e) {
  e.preventDefault();
  const form = e.currentTarget;
  const data = new FormData(form);
  const fields = {
    where: String(data.get('where') ?? ''),
    cat: String(data.get('cat') ?? ''),
    rule: String(data.get('rule') ?? ''),
    why: String(data.get('why') ?? ''),
  };
  const errors = fieldErrors(fields);
  showErrors(form, errors);
  if (Object.keys(errors).length) return;

  let tip;
  if (ui.form.id) {
    const existing = findTip(ui.form.id);
    if (!existing) {
      notify('That tip was deleted.', { error: true });
      backToList();
      return;
    }
    tip = updateTip(existing, fields);
    if (!sameTip(tip, existing)) save(upsertOp(tip, 'edit'));
  } else {
    tip = newTip({ ...fields, lat: ui.form.lat, lng: ui.form.lng }, { ids: store.tips.map((t) => t.id) });
    save(upsertOp(tip, 'add'));
  }
  map?.clearDraft();
  ui.form = null;
  showTip(tip.id);
}

function cancelForm() {
  map?.clearDraft();
  const id = ui.form?.id;
  ui.form = null;
  if (id) showTip(id);
  else backToList();
}

// ------------------------------------------------------ place and move

function placeView() {
  const pinning = ui.mode.kind === 'pin' ? findTip(ui.mode.id) : null;
  return h(
    'div',
    { class: 'mode' },
    h('p', { role: 'status' }, pinning ? `Tap the map where tip ${pinning.num} applies.` : 'Tap the map where this tip applies.'),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn', 'data-key': 'cancel', onclick: cancelMode }, 'Cancel'),
      h('button', { type: 'button', class: 'btn', onclick: placeAtMyLocation }, icon('locate'), 'Use my location')),
    !pinning && h('button', { type: 'button', class: 'btn btn-quiet', onclick: () => openAddForm(null) }, 'Add it without a pin'),
  );
}

function moveView() {
  const tip = findTip(ui.mode.id);
  return h(
    'div',
    { class: 'mode' },
    h('p', { role: 'status' }, `Drag pin ${tip?.num ?? ''}, or tap the map where it should go.`),
    h('div', { class: 'btn-row' },
      h('button', { type: 'button', class: 'btn', 'data-key': 'cancel', onclick: cancelMode }, 'Cancel'),
      h('button', { type: 'button', class: 'btn btn-primary', 'data-key': 'done', onclick: finishMove }, 'Save position')),
  );
}

function stopModes() {
  map?.stopPlacing();
  map?.stopMoving(false);
  map?.clearDraft();
}

function setView(view, extra = {}) {
  Object.assign(ui, { view, confirm: null }, extra);
  renderAll();
  if (view !== 'list' && view !== 'detail') renderPanel();
}

function startDrop() {
  stopModes();
  setView('place', { mode: { kind: 'new' }, selectedId: null, form: null });
  map.startPlacing((latlng) => openAddForm(latlng));
}

function startPin(id) {
  stopModes();
  setView('place', { mode: { kind: 'pin', id }, selectedId: id, form: null });
  map.startPlacing((latlng) => pinTip(id, latlng));
}

function pinTip(id, latlng) {
  const tip = findTip(id);
  if (!tip) return backToList();
  save(upsertOp(updateTip(tip, latlng), 'pin'));
  showTip(id);
}

async function placeAtMyLocation() {
  const mode = ui.mode;
  try {
    const you = await locate();
    if (ui.mode !== mode) return; // cancelled while waiting
    map.stopPlacing();
    map.showYou(you);
    if (mode.kind === 'pin') pinTip(mode.id, you);
    else openAddForm(you);
  } catch (err) {
    notify(err.message, { error: true });
  }
}

function startMove(id) {
  const tip = findTip(id);
  if (!tip || !map?.startMoving(tip)) return;
  setView('move', { mode: { kind: 'move', id }, selectedId: id });
  map.focus(tip, sheet.covered());
}

function finishMove() {
  const id = ui.mode.id;
  const to = map.stopMoving(true);
  const tip = findTip(id);
  ui.mode = null;
  if (tip && to) save(upsertOp(updateTip(tip, to), 'move'));
  showTip(id);
}

function cancelMode() {
  const back = ui.mode?.kind === 'new' ? null : ui.mode?.id;
  stopModes();
  ui.mode = null;
  if (back) showTip(back);
  else backToList();
}

// --------------------------------------------------- navigation actions

function openTip(id) {
  if (ui.view === 'form' || ui.view === 'place' || ui.view === 'move') return;
  showTip(id);
}

function showTip(id) {
  focusNext = 'back';
  setView('detail', { selectedId: id, mode: null });
  const tip = findTip(id);
  const pinned = tip && isPinned(tip) && map;
  // Half height leaves room to see the pin; an unpinned tip only needs the sheet open.
  if (pinned || sheet.state === 'peek' || sheet.state === 'fit') sheet.set('half');
  if (pinned) map.focus(tip, sheet.covered());
}

function backToList() {
  stopModes();
  if (ui.selectedId) focusNext = `open-${ui.selectedId}`;
  setView('list', { selectedId: null, mode: null, form: null });
}

function openAddForm(latlng) {
  stopModes();
  setView('form', { form: { id: null, lat: latlng?.lat ?? null, lng: latlng?.lng ?? null }, selectedId: null, mode: null });
  if (latlng) {
    map?.showDraft(latlng, (moved) => {
      ui.form.lat = moved.lat;
      ui.form.lng = moved.lng;
    });
  }
  sheet.set('full');
  if (sheet.desktop) {
    els.body.querySelector('#f-where')?.focus();
    if (latlng) map?.focus(latlng, 0, map.map.getZoom());
  }
}

function openEditForm(id) {
  const tip = findTip(id);
  if (!tip) return;
  setView('form', { form: { id, lat: tip.lat, lng: tip.lng }, selectedId: id });
  sheet.set('full');
  if (sheet.desktop) els.body.querySelector('#f-where')?.focus();
}

function setFilter(key) {
  ui.filter = key;
  try {
    storage?.setItem(FILTER_KEY, key);
  } catch {
    // Not remembered; that's fine.
  }
  renderAll();
}

function toggleKnown(id) {
  const tip = findTip(id);
  if (!tip) return;
  const status = tip.status === 'known' ? 'learning' : 'known';
  save(upsertOp(updateTip(tip, { status }), status));
}

function removeTip(id) {
  const tip = findTip(id);
  ui.confirm = null;
  if (tip) {
    save(deleteOp(tip));
    notify(`Deleted tip ${tip.num}.`);
  }
  backToList();
}

function discardChange(id) {
  ui.confirm = null;
  store.discard(id);
  if (!findTip(id)) backToList();
}

async function whereAmI() {
  els.locateBtn.setAttribute('aria-busy', 'true');
  try {
    const you = await locate();
    map.showYou(you);
    map.focus(you, sheet.covered(), 17);
    notify(`You're here, to within about ${you.accuracy} m.`, {
      action: { label: 'Add a tip here', onClick: () => openAddForm(you) },
      ms: 8000,
    });
  } catch (err) {
    notify(err.message, { error: true });
  } finally {
    els.locateBtn.removeAttribute('aria-busy');
  }
}

// ------------------------------------------------------------- settings

function applyToken(token) {
  store.commitText = token ? (args) => commitTextFile({ token, ...args }) : null;
  renderAll();
}

function setTokenStatus(text, kind = '') {
  els.tokenStatus.textContent = text;
  els.tokenStatus.className = `token-status ${kind}`;
}

function openSettings() {
  setTokenStatus(
    hasToken() ? 'A token is saved in this browser. Your changes here save for every device.' : 'No token on this device yet, so changes made here stay here.',
    hasToken() ? 'ok' : '',
  );
  els.tokenInput.value = '';
  els.settings.showModal();
}

els.tokenForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const token = els.tokenInput.value.trim();
  if (!token) {
    setTokenStatus('Paste a token first.', 'bad');
    return;
  }
  setTokenStatus('Checking the token with GitHub…');
  let checked = true;
  try {
    await checkToken({ token });
  } catch (err) {
    if (err.status !== 0) {
      setTokenStatus(err.message, 'bad');
      return;
    }
    checked = false; // offline: keep it anyway
  }
  const stored = saveToken(token, storage);
  applyToken(token);
  els.tokenInput.value = '';
  const notes = [
    checked ? `Token saved. It can see ${REPO.owner}/${REPO.repo}.` : "Token saved, but GitHub couldn't be reached to check it.",
    tokenKind(token) === 'classic' && 'This is a classic token, which can reach all your repos. A fine-grained one limited to this repo is safer.',
    !stored && "This browser won't store it, so you'll need to paste it again next time.",
  ];
  setTokenStatus(notes.filter(Boolean).join(' '), 'ok');
  syncLocal();
});

$('token-forget').addEventListener('click', () => {
  forgetToken(storage);
  applyToken('');
  els.tokenInput.value = '';
  setTokenStatus('Token removed from this browser.', 'ok');
});

$('settings-close').addEventListener('click', () => els.settings.close());
$('copy-close').addEventListener('click', () => els.copyDialog.close());
$('copy-select').addEventListener('click', () => els.copyBox.select());
for (const dialog of [els.settings, els.copyDialog]) {
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close(); // click on the backdrop
  });
}
$('repo-name').textContent = `${REPO.owner}/${REPO.repo}`;
$('repo-only').textContent = REPO.repo;

// ---------------------------------------------------------------- start

els.settingsBtn.addEventListener('click', openSettings);
els.dropBtn.addEventListener('click', startDrop);
els.locateBtn.addEventListener('click', whereAmI);
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (ui.view === 'place' || ui.view === 'move') cancelMode();
  else if (ui.view === 'form') cancelForm();
  else if (ui.view === 'detail') backToList();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') store.load();
});
addEventListener('online', syncLocal); // retry saves that failed for lack of signal

applyToken(readToken(storage));
store.load().then(() => {
  // Open the list part-way if there's something to do in it.
  if (store.tips.some((t) => !isPinned(t)) || store.entries('local').length) sheet.set('half');
  syncLocal(); // anything left over from last time, e.g. saved with no signal
});
