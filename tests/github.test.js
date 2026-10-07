import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  encodeBase64Utf8, decodeBase64Utf8, commitTextFile, readFile, checkToken,
  readToken, saveToken, forgetToken, tokenKind, GitHubError,
} from '../js/github.js';

const TOKEN = 'github_pat_SECRET_do_not_leak_1234567890';
const REPO = { owner: 'me', repo: 'tips', branch: 'main', path: 'tips.json' };
const FILE_URL = 'https://api.github.com/repos/me/tips/contents/tips.json';

// A fake Contents API holding one file. `conflicts` makes the next PUTs fail.
function fakeGitHub({ text = '[]\n', exists = true, conflicts = [], status = {} } = {}) {
  const gh = { text, sha: 'sha0', exists, conflicts: [...conflicts], requests: [], commits: 0 };
  gh.fetch = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    gh.requests.push({ url, method, headers: init.headers, body: init.body && JSON.parse(init.body), cache: init.cache });
    const reply = (code, body, headers = {}) => ({
      ok: code >= 200 && code < 300,
      status: code,
      headers: { get: (k) => headers[k.toLowerCase()] ?? null },
      json: async () => body,
    });
    if (status[method]) return reply(status[method], { message: 'Nope' }, status.headers);
    if (method === 'GET' && url.startsWith(FILE_URL)) {
      if (!gh.exists) return reply(404, { message: 'Not Found' });
      // Real responses wrap base64 at 60 characters.
      const content = encodeBase64Utf8(gh.text).replace(/(.{60})/g, '$1\n');
      return reply(200, { type: 'file', sha: gh.sha, encoding: 'base64', content });
    }
    if (method === 'PUT' && url === FILE_URL) {
      const body = JSON.parse(init.body);
      const conflict = gh.conflicts.shift();
      if (conflict) {
        conflict(gh); // someone else commits first
        return reply(409, { message: `is at ${gh.sha} but expected ${body.sha}` });
      }
      if (gh.exists ? body.sha !== gh.sha : body.sha !== undefined) return reply(409, { message: 'stale' });
      gh.text = decodeBase64Utf8(body.content);
      gh.exists = true;
      gh.commits += 1;
      gh.sha = `sha${gh.commits}`;
      return reply(gh.commits === 1 && !exists ? 201 : 200, {
        commit: { sha: `commit${gh.commits}`, html_url: `https://github.com/me/tips/commit/commit${gh.commits}` },
      });
    }
    if (method === 'GET' && url === 'https://api.github.com/repos/me/tips') return reply(200, { full_name: 'me/tips' });
    return reply(500, { message: `unexpected ${method} ${url}` });
  };
  return gh;
}

const append = (item) => (text) => `${JSON.stringify([...JSON.parse(text ?? '[]'), item], null, 2)}\n`;

test('base64 round-trips UTF-8 exactly like Node does', () => {
  const text = 'Gourock – café “quotes” ’ 🚗\nline two';
  assert.equal(encodeBase64Utf8(text), Buffer.from(text, 'utf8').toString('base64'));
  assert.equal(decodeBase64Utf8(Buffer.from(text, 'utf8').toString('base64').replace(/(.{60})/g, '$1\n')), text);
  const big = 'é'.repeat(100000);
  assert.equal(decodeBase64Utf8(encodeBase64Utf8(big)), big);
});

test('commit: GET for the sha, then PUT base64 content to the branch', async () => {
  const gh = fakeGitHub({ text: '[]\n' });
  const result = await commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'Add tip: Pier', update: append({ id: 'a', where: 'Pier – café' }) });
  assert.equal(result.changed, true);
  assert.deepEqual(result.commit, { sha: 'commit1', url: 'https://github.com/me/tips/commit/commit1' });
  const [get, put] = gh.requests;
  assert.equal(get.method, 'GET');
  assert.equal(get.url, `${FILE_URL}?ref=main`);
  assert.equal(get.cache, 'no-store');
  assert.equal(get.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(get.headers['X-GitHub-Api-Version'], '2022-11-28');
  assert.equal(put.method, 'PUT');
  assert.deepEqual(Object.keys(put.body).sort(), ['branch', 'content', 'message', 'sha']);
  assert.equal(put.body.sha, 'sha0');
  assert.equal(put.body.branch, 'main');
  assert.equal(put.body.message, 'Add tip: Pier');
  assert.equal(JSON.parse(gh.text)[0].where, 'Pier – café');
});

test('commit: a stale sha refetches, re-applies the change, and retries once', async () => {
  const gh = fakeGitHub({
    text: '[]\n',
    conflicts: [(g) => { g.text = append({ id: 'other' })(g.text); g.sha = 'shaOther'; }],
  });
  const seen = [];
  const update = (text) => { seen.push(text); return append({ id: 'mine' })(text); };
  const result = await commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'm', update });
  assert.equal(result.changed, true);
  assert.equal(seen.length, 2);
  assert.deepEqual(JSON.parse(seen[1]).map((t) => t.id), ['other']);
  assert.deepEqual(JSON.parse(gh.text).map((t) => t.id), ['other', 'mine']); // the other commit survives
  assert.equal(gh.requests.at(-1).body.sha, 'shaOther');
});

test('commit: gives up after the one retry', async () => {
  const bump = (g) => { g.sha += 'x'; };
  const gh = fakeGitHub({ conflicts: [bump, bump] });
  await assert.rejects(
    commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'm', update: append(1) }),
    (err) => err instanceof GitHubError && err.status === 409,
  );
  assert.equal(gh.requests.filter((r) => r.method === 'PUT').length, 2);
});

test('commit: 422 also counts as stale and is retried', async () => {
  const gh = fakeGitHub();
  const real = gh.fetch;
  let first = true;
  gh.fetch = async (url, init) => {
    if (init?.method === 'PUT' && first) {
      first = false;
      return { ok: false, status: 422, headers: { get: () => null }, json: async () => ({ message: 'sha wasn\'t supplied' }) };
    }
    return real(url, init);
  };
  const result = await commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'm', update: append(1) });
  assert.equal(result.changed, true);
});

test('commit: creates the file when it does not exist yet', async () => {
  const gh = fakeGitHub({ exists: false });
  const seen = [];
  await commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'm', update: (t) => { seen.push(t); return '[]\n'; } });
  assert.deepEqual(seen, [null]);
  assert.equal('sha' in gh.requests[1].body, false);
});

test('commit: no PUT when nothing changes', async () => {
  const gh = fakeGitHub({ text: '[1]\n' });
  const result = await commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'm', update: (t) => t });
  assert.deepEqual(result, { changed: false, commit: null });
  assert.equal(gh.requests.length, 1);
});

test('commit: refusals from update() stop the save before any PUT', async () => {
  const gh = fakeGitHub({ text: '{broken' });
  await assert.rejects(
    commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'm', update: () => { throw new Error('bad JSON'); } }),
    /bad JSON/,
  );
  assert.equal(gh.requests.some((r) => r.method === 'PUT'), false);
});

test('errors are readable and never contain the token', async () => {
  const cases = [
    [{ GET: 401 }, /rejected the token/],
    [{ PUT: 403 }, /Contents: read and write/],
    [{ PUT: 403, headers: { 'x-ratelimit-remaining': '0' } }, /rate limit/],
    [{ PUT: 404 }, /can't find me\/tips on branch "main"/],
    [{ PUT: 500 }, /GitHub said 500: Nope/],
  ];
  for (const [status, pattern] of cases) {
    const gh = fakeGitHub({ status });
    const err = await commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, message: 'm', update: append(1) }).catch((e) => e);
    assert.ok(err instanceof GitHubError, String(err));
    assert.match(err.message, pattern);
    assert.ok(!JSON.stringify({ ...err, message: err.message, stack: err.stack }).includes(TOKEN));
  }
  const offline = async () => { throw new TypeError(`failed to fetch with ${TOKEN}`); };
  const err = await readFile({ token: TOKEN, repo: REPO, fetchImpl: offline }).catch((e) => e);
  assert.match(err.message, /Couldn't reach GitHub/);
  assert.ok(!err.message.includes(TOKEN) && !err.stack.includes(TOKEN));
});

test('checkToken reads the repo', async () => {
  assert.equal(await checkToken({ token: TOKEN, repo: REPO, fetchImpl: fakeGitHub().fetch }), true);
  await assert.rejects(checkToken({ token: TOKEN, repo: REPO, fetchImpl: fakeGitHub({ status: { GET: 401 } }).fetch }), /rejected/);
});

test('token storage: save trims, forget removes, broken storage is harmless', () => {
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, v), removeItem: (k) => map.delete(k) };
  assert.equal(readToken(storage), '');
  assert.equal(saveToken(`  ${TOKEN}\n`, storage), true);
  assert.equal(readToken(storage), TOKEN);
  forgetToken(storage);
  assert.equal(readToken(storage), '');
  const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); }, removeItem() { throw new Error('denied'); } };
  assert.equal(readToken(broken), '');
  assert.equal(saveToken(TOKEN, broken), false);
  forgetToken(broken);
  assert.deepEqual([tokenKind(TOKEN), tokenKind('ghp_x'), tokenKind('hello')], ['fine-grained', 'classic', 'unknown']);
});

test('store + GitHub together: a toggle commits only that tip', async () => {
  const { TipStore, upsertOp, validateTip, toStored } = await import('../js/tips.js');
  const a = validateTip({ id: 'a', where: 'A', cat: 'hill', rule: 'R', lat: null, lng: null, status: 'learning', createdAt: '2026-01-01T00:00:00Z' }).tip;
  const b = { ...a, id: 'b', where: 'B', createdAt: '2026-01-02T00:00:00Z' };
  const fileText = `${JSON.stringify([toStored(a), toStored(b)], null, 2)}\n`;
  const gh = fakeGitHub({ text: fileText });
  const site = async () => ({ ok: true, status: 200, text: async () => fileText });
  const store = new TipStore({ fetchImpl: site, pollMs: null });
  await store.load();
  store.commitText = ({ update, message }) => commitTextFile({ token: TOKEN, repo: REPO, fetchImpl: gh.fetch, update, message });
  const entry = await store.save(upsertOp({ ...b, status: 'known' }, 'known'));
  assert.equal(entry.state, 'committed');
  assert.equal(gh.requests.at(-1).body.message, 'Got it: B');
  assert.deepEqual(JSON.parse(gh.text).map((t) => [t.id, t.status]), [['a', 'learning'], ['b', 'known']]);
});
