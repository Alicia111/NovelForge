---
name: run-novelforge
description: Build, run, and drive NovelForge (FastAPI backend + Vue/Element-Plus web GUI). Use when asked to start NovelForge, run its backend API, launch its web GUI, take a screenshot of it, or interact with the running app.
---

NovelForge is a FastAPI backend (`backend/`) plus a Vue 3 frontend
(`frontend/`) that ships both as an Electron desktop app and, via
`npm run dev:web`, as a plain browser web app. For agent/automated use,
run the backend and the web GUI, then drive the GUI with the headless
Chromium REPL at `.claude/skills/run-novelforge/driver.mjs` (this
environment has no `chromium-cli`, so the driver talks to the system
`/usr/bin/chromium` directly via `playwright-core`). The Electron
desktop shell is not covered here — it wasn't exercised, see Gotchas.

All paths below are relative to the repo root (`NovelForge/`).

## Prerequisites

```bash
# System Chromium, used by the driver (there is no chromium-cli in this environment)
sudo apt-get update && sudo apt-get install -y chromium

# Node 18+ and Python 3.11+ (this session used Node v25, Python 3.13)
```

## Setup

```bash
# Backend: venv + deps (no conda on this machine)
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
cp .env.example .env   # default APP_PORT=54321, CORS_ORIGINS=*

# Frontend: npm deps
cd ../frontend
npm install

# Driver: its own isolated node_modules (keeps playwright-core out of
# frontend/'s package.json)
cd ../.claude/skills/run-novelforge
npm install
```

`frontend/vite.config.web.ts` needs `server.host: true` for the GUI to
be reachable from anywhere but localhost (e.g. over Tailscale/LAN) —
already set in this repo; if it's ever missing, `npm run dev:web` only
binds loopback.

## Build

No separate build step for dev use — `dev:web` runs Vite directly
against source. (`npm run build:web` in `frontend/` produces a static
`dist-web/` bundle for production, not exercised here.)

## Run (agent path)

Start both servers in the background, then drive the GUI:

```bash
# Backend — binds 0.0.0.0 by default (backend/main.py)
cd backend && nohup .venv/bin/python main.py > /tmp/backend.log 2>&1 &
timeout 30 bash -c 'until curl -sf http://127.0.0.1:54321/ >/dev/null; do sleep 1; done'
curl -s http://127.0.0.1:54321/
# -> {"message":"Welcome to NovelForge API","version":"1.0.0"}

# Frontend — Vite picks the next free port if 5173 is taken; read the
# "Local:" line it prints and use that port below.
cd ../frontend && nohup npm run dev:web > /tmp/frontend.log 2>&1 &
timeout 30 bash -c 'until grep -q "Local:" /tmp/frontend.log; do sleep 1; done'
grep Local: /tmp/frontend.log
```

Then drive the GUI, wrapped in tmux (poll for markers, not `sleep`):

```bash
cd /path/to/NovelForge
tmux new-session -d -s nf -x 200 -y 50
tmux send-keys -t nf 'FRONTEND_URL=http://127.0.0.1:<port> node .claude/skills/run-novelforge/driver.mjs' Enter
timeout 15 bash -c 'until tmux capture-pane -t nf -p | grep -q "driver>"; do sleep 0.2; done'
tmux send-keys -t nf 'launch' Enter
timeout 30 bash -c 'until tmux capture-pane -t nf -p | grep -q "launched"; do sleep 0.2; done'
tmux send-keys -t nf 'ss 01-landing' Enter
timeout 15 bash -c 'until tmux capture-pane -t nf -p | grep -q "screenshot:"; do sleep 0.2; done'
tmux capture-pane -t nf -p
```

Screenshots land in `/tmp/shots/` (override with `SCREENSHOT_DIR`).
`FRONTEND_URL` sets the default `launch` target (default
`http://127.0.0.1:5173`); pass a URL to `launch <url>` to override
per-call instead.

### Driver commands

| command | what it does |
|---|---|
| `launch [url]` | launch Chromium, open `url` (default `$FRONTEND_URL`) |
| `nav <url>` | navigate the existing page |
| `ss [name]` | screenshot -> `/tmp/shots/<name>.png` |
| `click <css-sel>` | click element via DOM `.click()` |
| `click-text <text>` | click the button/link whose text matches |
| `fill <css-sel> <text>` | set an input's value (Vue-aware, via Playwright `fill`) |
| `type <text>` / `press <key>` | keyboard input |
| `wait <css-sel>` | wait for element, 10s timeout |
| `eval <js>` | evaluate in the page, print JSON |
| `text [css-sel]` | print innerText (whole page if no selector) |
| `console [errors]` | print captured console/page-error messages |
| `quit` | close browser, exit |

### Verified this session

```
driver> launch
launched, at http://127.0.0.1:5174/
driver> ss 01-landing
screenshot: /tmp/shots/01-landing.png     # -> renders "我的书架" (My Bookshelf) landing page
driver> console errors
[error] Failed to load resource: the server responded with a status of 404 (Not Found)   # favicon.ico, harmless — see Gotchas
```

Stop the servers by port (not `$!` — see Gotchas):

```bash
lsof -ti:54321 -sTCP:LISTEN | xargs -r kill   # backend (also kills its --reload child)
lsof -ti:5174  -sTCP:LISTEN | xargs -r kill   # frontend — use whatever port Vite actually bound
```

## Run (human path)

```bash
npm run dev   # repo root - Windows-only (uses `start "..." powershell`), don't use on Linux
```

On Linux/macOS, run the two halves of that script by hand instead:
`python backend/main.py` and `npm --prefix frontend run dev` (Electron
desktop) or `npm --prefix frontend run dev:web` (browser). Both open
UI a human drives interactively; useless in a headless container.

## Test

Not exercised this session (no test run was needed to satisfy this
skill's goal of proving the GUI launches and renders).

## Gotchas

- **`npm start &` then `kill $!` doesn't stop the backend.** `python
  main.py` runs Uvicorn with `reload=True`, which forks a `StatReload`
  child that actually holds the port; the parent PID alone doesn't
  free it. Kill by port (`lsof -ti:<port> -sTCP:LISTEN | xargs -r kill`).
- **Vite silently moves off port 5173** if something else already
  listens there (it did on this machine — landed on 5174). Don't
  hardcode the port; read it from the dev-server log's `Local:` line.
- **`frontend/vite.config.web.ts` must have `server.host: true`.**
  Vite's default binds loopback only; without this line the GUI is
  unreachable from anything but the machine running it (including from
  the driver if it's ever run against a different host).
- **`frontend/vite.config.web.ts` must also have `server.allowedHosts: true`.**
  Vite 5+ rejects requests whose `Host` header it doesn't recognize —
  raw IPs work, but a LAN/Tailscale MagicDNS hostname (e.g. `nekolia`,
  `nekolia.tail117e62.ts.net`) gets `Blocked request. This host is not
  allowed.` until this is set. Requires a dev-server restart to take
  effect (not hot-reloadable).
- **`favicon.ico` 404s** on every load (`curl -s -o /dev/null -w '%{http_code}'
  http://127.0.0.1:<port>/favicon.ico` -> `404`) and shows up as a
  console error in the driver's `console errors` output. Cosmetic only
  — the page renders fine regardless; don't chase it as a real bug.
- **Driver's `node_modules` is scoped to the skill directory**
  (`.claude/skills/run-novelforge/`), not `frontend/`'s — `require`ing
  `playwright-core` from anywhere else in the repo fails with
  `MODULE_NOT_FOUND`. Run `node driver.mjs` from inside the skill dir
  (the tmux command above already does this via the repo-root-relative
  path, which Node resolves relative to the script's own location).
- **Electron desktop mode wasn't driven here.** This container has no
  display server; getting Electron to launch under `xvfb-run` with
  `--no-sandbox` (see the generator's `examples/electron.md` pattern)
  is a separate, unverified effort — the `dev:web` browser path above
  is what's actually proven to work headless.

## Troubleshooting

- **`curl: (7) Failed to connect` to the backend right after starting
  it:** the reload watcher takes a couple seconds to bind — the
  `timeout 30 ... until curl -sf` loop in Run handles this; don't
  `sleep` a fixed amount and give up early.
- **`Error: Cannot find module 'playwright-core'`:** you ran `node`
  from outside `.claude/skills/run-novelforge/`. `cd` there first, or
  invoke by full path as shown above.
