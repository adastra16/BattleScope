# BattleScope: LILA BLACK Player Journey Explorer

A browser tool for Level Designers. It shows where players move, fight, loot and die on LILA BLACK's maps, and lets you replay any match.

**Live app:** https://battle-scope.vercel.app
**Docs:** [ARCHITECTURE.md](ARCHITECTURE.md) · [INSIGHTS.md](INSIGHTS.md)

## Architecture at a glance

| Folder | What | Tech | Hosted on |
|---|---|---|---|
| [`pipeline/`](pipeline/) | ETL: raw parquet → compact numpy store + web minimaps | Python, pyarrow, pandas, Pillow | runs offline |
| [`backend/`](backend/) | REST API: matches, replays, heatmaps, events, summary, zones, flow | FastAPI + numpy only | Vercel (Python function at `/api`) |
| [`frontend/`](frontend/) | UI: map, replay, heatmaps, filters | HTML + CSS + vanilla JS modules, Canvas 2D, no build step | Vercel (static) |

Details and trade-offs are in [ARCHITECTURE.md](ARCHITECTURE.md).

## The five sections

Each section is its own page with its **own filter bar** (map, dates, players, plus whatever that view needs), so nothing is crammed into one screen.

| Section | Question it answers | Highlights |
|---|---|---|
| **01 Briefing** | How do runs end? | Auto-written intel line, KPIs, how runs end, when players die, and all three maps side by side with live death-heat thumbnails. |
| **02 Map Lab** | Where does it happen? | Heatmaps (traffic, kills, deaths, storm, loot), event markers, a **match-time window** with a Sweep button that fills the map in over time, and a click-to-inspect **zone card**. **Beyond the brief:** a *Flow* layer draws animated arrows for where players actually walk between zones, and the zone card lists where players arrive from and leave to. Click any marker to replay its match. |
| **03 Replay** | How did this match play out? | Match list with its own search / sort / 2+ players filters, playback at 0.1× / 0.5× / 1× / 1.5× / 2× / 5× / 10× (`[` and `]` change speed), event histogram on the scrubber, per-player panel (click to focus), shareable moment links. |
| **04 Compare** | What changes between two slices? | Side A vs side B with presets (Humans vs Bots, Kills vs Deaths, Loot vs Deaths, Early vs Late, Day vs Day) and a **difference map**. Panning and zooming are linked across all three maps. Shows a similarity score and where each side dominates. |
| **05 Design Radar** | Where does the design leak? | Every zone scored for risk vs reward, tagged **Meat grinder / Loot buffet / Storm magnet / Tumbleweed / Fair fight**, plotted on a quadrant chart, and explained in auto-generated findings that each end with a suggested design lever. **Beyond the brief:** one click copies the findings as a Markdown report (or downloads it) for Notion, Jira or Slack. |

Across all sections:

* **Correct minimap mapping.** World `(x, z)` goes to the minimap through per-map scale/origin, in resolution-independent UV space.
* **Humans vs bots.** Humans have a solid cyan path and a round head. Bots have a dashed orange path and a diamond head. Filled markers are human events, hollow markers are bot events.
* **Event markers.** Kill (red ring), death (white ✕), storm death (violet ◆), loot (yellow ■), each toggleable, with hover details.
* **Things that move.** A few drifting arcade icons, shimmering comic headlines with a per-section accent colour, counters that count up, sonar pings on the deadliest zones in Design Radar, ripples that radiate from kills and deaths during Replay, confetti when a replayed human makes it out, and a mascot you can poke. Everything respects `prefers-reduced-motion`.
* **Look and feel.** A comic-book arcade theme drawn from LILA BLACK's key art (indigo sky, acid yellow, lots of neon pink), plus Zorp, a one-eyed neon-pink alien whose eye follows your cursor (poke it, it has opinions about GTA 6). Zone types have playful names; the rule behind each is in the Map Lab inspector and in ARCHITECTURE.md.
* **Shareable links.** Section, map, match and paused time live in the URL (`#/replay?match=…&t=…`).
* **About the data.** The ⓘ button in the left rail opens the data-quality report and the assumptions.

## Run locally

Requires Python 3.10+.

```bash
python3 -m venv .venv && source .venv/bin/activate
pip install -r pipeline/requirements.txt -r backend/requirements.txt

# 1. (Optional) rebuild the data store from the raw dump. The processed store is already committed.
python -I pipeline/build.py /path/to/player_data backend/data frontend

# 2. Start the API → http://localhost:8000  (interactive docs at /api/docs)
cd backend && uvicorn app.main:app --port 8000

# 3. In another terminal, serve the frontend → http://localhost:5173
cd frontend && python3 -m http.server 5173
```

Open **http://localhost:5173**. On port 5173 the frontend talks to the API on `http://localhost:8000`; deployed on Vercel it uses the same origin (`/api/...`). See [`frontend/config.js`](frontend/config.js); you can also override it per visit with `?api=https://host`.

Tests, audit and stats:

```bash
pip install -r backend/requirements-dev.txt
cd backend && pytest -q                           # API tests against the real data
python -I pipeline/audit.py /path/to/player_data  # recomputes headline numbers from the RAW files and diffs them against the running API
python -I pipeline/insights.py backend/data       # reproduces every number in INSIGHTS.md
```

## Environment variables (backend)

| Var | Default | Purpose |
|---|---|---|
| `DATA_DIR` | `backend/data` | Folder with `store.npz`, `matches.json`, `meta.json` |
| `CORS_ORIGINS` | `*` | Comma-separated allowed origins (only matters if the frontend is hosted on a different origin) |

On Vercel no variables are needed: the frontend and the API share one origin.

## Deploy (Vercel only)

One Vercel project serves both parts: the static frontend from `frontend/` and the API as a Python function from [`api/index.py`](api/index.py). Everything is configured in [`vercel.json`](vercel.json), so there are no environment variables and no second service.

1. Push the repo to GitHub.
2. Vercel → **Add New → Project** → import the repo.
3. Leave **Root Directory** as the repo root and set **Framework Preset** to **Other**. Leave Build, Output and Install commands as they are (`vercel.json` sets them).
4. Click **Deploy**.
5. Check it: open `https://<your-project>.vercel.app/api/health` (should show `{"status":"ok","matches":796}`), then the site itself.

Python dependencies come from the root [`requirements.txt`](requirements.txt) (just `fastapi` and `numpy`). Later pushes to `main` redeploy automatically.

## Walkthrough

1. **Briefing.** Open the app. The intel line and KPIs summarise Ambrose Valley. Switch Players to *Bots* or untick dates and everything recomputes. Click a map card to switch map.
2. **Map Lab.** Pick *Deaths*, drag the match-time window to the first five minutes, or press **Sweep** to watch deaths accumulate. Turn on *Zone grid* and click a zone to read its traffic, loot, kills and risk.
3. **Replay.** Sort the list by *Most combat*, pick a match and let it autoplay. Click a player in the panel to isolate their route. Pause and copy the URL to share that exact moment.
4. **Compare.** Choose *Loot vs Deaths*. Lime marks where loot is concentrated relative to deaths (the safe towns) and fuchsia marks where deaths dominate (the central killzone).
5. **Design Radar.** Read the auto-generated findings, hover a bubble to light up its zone on the map, and filter the table by zone type.

## Repo layout

```
pipeline/build.py            raw parquet → backend/data/{store.npz,matches.json,meta.json,*.parquet}, frontend/minimaps/*.jpg
pipeline/audit.py            independent raw-data vs API consistency check
pipeline/insights.py         reproducible stats behind INSIGHTS.md
pipeline/explore.py          initial data-quality exploration
backend/app/main.py          FastAPI routes, validation, CORS/gzip (docs at /api/docs)
backend/app/store.py         numpy-only query layer: filters, replay, heat grid, summary, zones, flow
backend/tests/test_api.py    API tests (11)
backend/data/                processed store (committed, ~3 MB; the API reads store.npz + matches.json)
frontend/index.html          shell (left rail + view container)     frontend/config.js   API base URL (same origin on Vercel)
frontend/src/app.js          rail navigation + hash router + About dialog
frontend/src/views/          overview · explore · replay · compare · radar   (one module per section)
frontend/src/ui.js           DOM helper + shared filter controls (segmented, date chips, time window, ...)
frontend/src/mapview.js      reusable minimap canvas (pan/zoom, heat layer, grid, overlay hook)
frontend/src/charts.js       SVG charts (stacked columns, risk/reward quadrant)
frontend/src/heatmap.js      smoothing + colour ramp, plus the A-vs-B difference renderer
frontend/src/render.js       canvas drawing: markers, paths, heads, grid
frontend/src/api.js          API client (cached)    frontend/src/view.js   UV → screen camera
frontend/src/constants.js    event codes, colours, zone tags, labels
api/index.py                 Vercel function entrypoint (exposes backend/app as /api)
vercel.json                  Vercel config: static frontend + /api function + cache headers
requirements.txt             Python deps for the Vercel function (fastapi, numpy)
```
