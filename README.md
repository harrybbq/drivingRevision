# Tip map

Driving tips from my instructor, pinned to the places they apply around Greenock, Gourock and Port Glasgow, plus a revision sheet.

## What this is

- `index.html` is the map page. Its header reads "Tip map" (with "Greenock · Gourock" above it) and links to the revision sheet as "Faults sheet". Each tip is a numbered pin with where it is, what to do and, if useful, why.
- `revision.html` is the "Six Faults to Fix" revision sheet, worked through the instructor's routine, MSPSpG (Mirror, Signal, Position, Speed, Gear). It links back to the map with "← Tip map".
- Plain HTML, CSS and JavaScript ES modules. No build step, no framework.
- The map uses Leaflet 1.9.4 from unpkg (version pinned, with SRI) and OpenStreetMap tiles.

## Live site

GitHub Pages addresses follow the pattern `https://<github-username>.github.io/<repo-name>/`, so this site is at:

- Map: https://harrybbq.github.io/drivingRevision/
- Faults sheet: https://harrybbq.github.io/drivingRevision/revision.html

After each commit it takes about a minute for the live site to update.

## Turn on GitHub Pages (one-off)

1. Open the repo on GitHub, then **Settings** → **Pages**.
2. Under "Build and deployment", set **Source** to "Deploy from a branch".
3. Set **Branch** to `main` and the folder to `/ (root)`, then press **Save**.

The first deploy takes a minute or two. The site's URL then appears at the top of that Pages settings page. The empty `.nojekyll` file tells GitHub Pages to serve the files as they are.

Optional: **Settings** → **General** → **Default branch** → switch to `main`. The repo's default branch was created as `claude/inspiring-goldberg-rxls2m` because it was the first branch pushed.

## Using the map

- Each tip is a numbered teardrop pin, coloured by category. Tips are numbered in the order they were added (`createdAt`), so a tip keeps its number whichever filter is on.
- Tap a pin or a list item to see the details.
- **Drop a pin**: tap the map where the tip applies, then fill in where, category, what to do and why.
- **Where am I**: shows your position using the browser's location. **Add a tip here** then starts a tip at that spot.
- **Got it** marks a tip as learned; tap it again to undo. Got-it pins fade so the ones still to learn stand out.
- Filters: **All**, **Still learning**, **Got it**.
- **Edit** changes the text. **Move pin**: drag the pin, or tap where it should go. **Delete** asks you to confirm on the page first.
- Tips without a position show as "Not pinned yet", with a **Pin on map** button.
- On a desktop the list sits beside the map. On a phone it is a bottom sheet you can drag up.

## Saving: the repo is the database

Tips live in `tips.json` at the root of the repo. There is no other backend.

- Saving commits `tips.json` to the `main` branch through the GitHub Contents API, straight from your browser, using a token you paste in once (see below).
- The change shows on the page straight away, and the page tells you when the commit has landed.
- GitHub Pages then takes about a minute to redeploy. Until the live `tips.json` catches up, the page keeps showing your local copy. It re-checks every 15 seconds and stops overriding after 30 minutes.
- If two saves race, the page fetches the latest `tips.json` and re-applies your change, once.
- Saves go one at a time.

## Create the token (fine-grained personal access token)

1. On GitHub, click your profile picture → **Settings** → **Developer settings** → **Personal access tokens** → **Fine-grained tokens** → **Generate new token**. Direct link: https://github.com/settings/personal-access-tokens/new
2. **Token name**: something like "Driving tips map".
3. **Expiration**: your choice, for example 90 days. When it expires you will need to make a new one.
4. **Resource owner**: `harrybbq`.
5. **Repository access**: "Only select repositories", then pick `drivingRevision`.
6. **Permissions** → **Repository permissions** → **Contents**: "Read and write". GitHub adds **Metadata: Read-only** automatically; that is expected. Nothing else is needed.
7. Press **Generate token** and copy the token (it starts `github_pat_`).
8. Open the map, press the gear (**Settings**) button, paste the token and press **Save token**. The page checks that the token can see the repo.

### Security

- The token is stored only in this browser's `localStorage`, on this device. It is never committed, never logged and never put in a URL.
- **Forget token** in Settings removes it.
- Anyone using the same browser profile could use it, so don't save it on a shared computer.
- If it leaks, delete it at https://github.com/settings/personal-access-tokens

## Every device sees the same pins

Anyone can view the map on any device: it reads the public `tips.json`. Changes only reach other devices once they're committed to GitHub, so add the token (once) on each device you edit with, usually your phone.

Without a token on a device, changes you make there:

- stay in that browser (they survive reloads), with a dashed outline on their pins, a red count on the Settings button and an "only on this device" note in the list, and
- are copied to the clipboard as JSON, so you can paste them to Claude to commit.

As soon as you add a token, any changes waiting on that device are saved to GitHub automatically. Saves that failed for lack of signal are retried when the page next opens or the connection comes back.

## tips.json format

`tips.json` is a JSON array of tip objects. This one is a made-up example, not a real tip:

```json
[
  {
    "id": "k3x9q2ab",
    "where": "Example roundabout",
    "cat": "junction",
    "rule": "What to do at this spot.",
    "why": "Why it matters (optional).",
    "lat": 55.95,
    "lng": -4.76,
    "status": "learning",
    "createdAt": "2026-01-01T09:00:00.000Z"
  }
]
```

| Field | Meaning |
| --- | --- |
| `id` | Short unique id (letters, numbers, `-` or `_`). |
| `where` | Where the tip applies, in words. |
| `cat` | Category key (see below). |
| `rule` | What to do. |
| `why` | Optional reason. Left out when empty. |
| `lat`, `lng` | Position as numbers, or `null` when not pinned yet. |
| `status` | `"learning"` or `"known"` (Got it). |
| `createdAt` | When the tip was added, ISO 8601. Sets the tip's number. |

| Category key | Shown as |
| --- | --- |
| `junction` | Junction or roundabout |
| `speed` | Speed limit |
| `lanes` | Lanes & road markings |
| `hill` | Hill |
| `priority` | Narrow road or priority |
| `hazard` | Hazard (school, crossing, bus stop) |
| `manoeuvre` | Manoeuvre spot |
| `other` | Other |

Entries the page can't read (for example a missing `id`, `where`, `rule` or `createdAt`) are skipped and reported on the page. They are never deleted from the file. An unknown `cat` shows as Other, and an unknown `status` as still learning.

## Files

| Path | What it does |
| --- | --- |
| `index.html` | The map page. |
| `css/app.css` | Styles for the map page. |
| `js/app.js` | Page wiring and panel views. |
| `js/map.js` | Leaflet map, pins, placing and moving pins, location. |
| `js/sheet.js` | Phone bottom sheet. |
| `js/dom.js` | Small DOM helpers. Text only, no `innerHTML` from data. |
| `js/tips.js` | Data: load, validate, number, filter, save and merge. No DOM. |
| `js/github.js` | GitHub Contents API and token storage. |
| `js/config.js` | Repo owner, name, branch and path to `tips.json`. |
| `tips.json` | The tips. |
| `revision.html` | The "Six Faults to Fix" revision sheet. |
| `tests/` | Node tests. |

## Development

Serve the folder with any static server, for example:

```sh
python3 -m http.server 8000
```

then open http://localhost:8000/. Opening `index.html` directly as a `file://` URL won't work, because ES modules and `fetch` need a web server.

Run the tests (Node 20 or newer, nothing to install):

```sh
npm test
```

Saving with a token from a local copy still commits to the real `main` branch on GitHub.
