// Commits a file back to the repo through the GitHub Contents API.
// The token is kept in this browser's localStorage only. It is never logged,
// never put in a URL, and never included in an error message.

import { REPO } from './config.js';

const API = 'https://api.github.com';
const TOKEN_KEY = 'drivingRevision:githubToken';

export class GitHubError extends Error {
  name = 'GitHubError';

  constructor(message, status = 0) {
    super(message);
    this.status = status;
  }
}

// ------------------------------------------------------------------- token

export function readToken(storage = globalThis.localStorage) {
  try {
    return storage?.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

export function saveToken(token, storage = globalThis.localStorage) {
  try {
    storage.setItem(TOKEN_KEY, token.trim());
    return true;
  } catch {
    return false;
  }
}

export function forgetToken(storage = globalThis.localStorage) {
  try {
    storage?.removeItem(TOKEN_KEY);
  } catch {
    // Nothing stored, or storage is unavailable: either way it's gone.
  }
}

// Fine-grained tokens start github_pat_; classic ones ghp_ (they work, but can see every repo).
export const tokenKind = (token) =>
  token.startsWith('github_pat_') ? 'fine-grained' : token.startsWith('ghp_') ? 'classic' : 'unknown';

// ------------------------------------------------------------------ base64

// btoa/atob only handle Latin-1, so go through UTF-8 bytes (é, –, ’ and emoji all survive).
export function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

export function decodeBase64Utf8(base64) {
  const binary = atob(base64.replace(/\s+/g, '')); // the API wraps content every 60 characters
  return new TextDecoder().decode(Uint8Array.from(binary, (c) => c.charCodeAt(0)));
}

// ---------------------------------------------------------------- requests

function contentsUrl(repo) {
  const path = repo.path.split('/').map(encodeURIComponent).join('/');
  return `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}/contents/${path}`;
}

async function request(fetchImpl, url, token, { method = 'GET', body } = {}) {
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  try {
    return await fetchImpl(url, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store', // the sha must be fresh, or the PUT is refused
    });
  } catch {
    throw new GitHubError("Couldn't reach GitHub. Check your connection.");
  }
}

async function errorFrom(res, repo) {
  let detail = '';
  try {
    detail = (await res.json())?.message ?? '';
  } catch {
    // No JSON body.
  }
  const where = `${repo.owner}/${repo.repo}`;
  switch (res.status) {
    case 401:
      return new GitHubError('GitHub rejected the token. It may have expired. Paste a new one in Settings.', 401);
    case 403:
    case 429:
      if (res.status === 429 || res.headers.get('x-ratelimit-remaining') === '0') {
        return new GitHubError('GitHub rate limit reached. Try again in a few minutes.', res.status);
      }
      return new GitHubError(
        `The token can't write to ${where}. It needs "Contents: read and write" on this repo.`,
        403,
      );
    case 404:
      return new GitHubError(
        `GitHub can't find ${where} on branch "${repo.branch}". Check the token is for this repo and the branch exists.`,
        404,
      );
    case 409:
      return new GitHubError(`${repo.path} changed on GitHub while saving.`, 409);
    case 422:
      return new GitHubError(`GitHub refused the save${detail ? `: ${detail}` : ''}.`, 422);
    default:
      return new GitHubError(`GitHub said ${res.status}${detail ? `: ${detail}` : ''}.`, res.status);
  }
}

// Reads the file. Returns { sha, text }, or { sha: null, text: null } if it doesn't exist yet.
export async function readFile({ token, repo = REPO, fetchImpl = globalThis.fetch }) {
  const res = await request(fetchImpl, `${contentsUrl(repo)}?ref=${encodeURIComponent(repo.branch)}`, token);
  if (res.status === 404) return { sha: null, text: null };
  if (!res.ok) throw await errorFrom(res, repo);
  const body = await res.json();
  if (body?.type !== 'file' || typeof body.sha !== 'string') {
    throw new GitHubError(`${repo.path} in the repo isn't a file.`);
  }
  if (body.encoding !== 'base64' || typeof body.content !== 'string') {
    throw new GitHubError(`${repo.path} is too big to edit through the API (over 1 MB).`);
  }
  return { sha: body.sha, text: decodeBase64Utf8(body.content) };
}

async function writeFile({ token, repo, fetchImpl, sha, text, message }) {
  const body = { message, content: encodeBase64Utf8(text), branch: repo.branch };
  if (sha) body.sha = sha;
  const res = await request(fetchImpl, contentsUrl(repo), token, { method: 'PUT', body });
  if (!res.ok) throw await errorFrom(res, repo);
  const { commit } = await res.json();
  return { sha: commit.sha, url: commit.html_url };
}

// Commits update(currentText) as the new file. update gets null if the file
// doesn't exist yet, and may throw to refuse (e.g. the file isn't valid JSON).
// If GitHub refuses because the file moved on (409/422 on a stale sha), it
// fetches the file again, re-applies update to the new text, and retries once.
// Resolves { changed: false, commit: null } when there was nothing to change.
export async function commitTextFile({ token, update, message, repo = REPO, fetchImpl = globalThis.fetch }) {
  for (let attempt = 1; ; attempt++) {
    const { sha, text } = await readFile({ token, repo, fetchImpl });
    const next = update(text);
    if (next === text) return { changed: false, commit: null };
    try {
      return { changed: true, commit: await writeFile({ token, repo, fetchImpl, sha, text: next, message }) };
    } catch (error) {
      if (attempt === 1 && (error.status === 409 || error.status === 422)) continue;
      throw error;
    }
  }
}

// Checks a token can at least read the repo. Write access only shows on the first save.
export async function checkToken({ token, repo = REPO, fetchImpl = globalThis.fetch }) {
  const res = await request(fetchImpl, `${API}/repos/${encodeURIComponent(repo.owner)}/${encodeURIComponent(repo.repo)}`, token);
  if (!res.ok) throw await errorFrom(res, repo);
  return true;
}
