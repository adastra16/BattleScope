# Architecture

Three independent pieces with one-way dependencies: **ETL pipeline → API backend → web frontend**.

```
 player_data/ (1,243 parquet files, 34 MB)
        │  pipeline/build.py  (run once, offline)
        ▼
 backend/data/store.npz        88,894 clean events as numpy arrays (0.7 MB)      frontend/minimaps/*.jpg  (2048², static)
 backend/data/matches.json     796 match summaries
 backend/data/meta.json        map config, days, data-quality report
 backend/data/*.parquet        the same data as parquet, for analysts (not read by the API)
        │  loaded into memory when the function starts
        ▼
  backend/ — FastAPI on Vercel  /api/meta  /api/maps/{map}/matches  /api/matches/{id}
                               /api/maps/{map}/heatmap  /events  /summary  /zones  /flow
        │  JSON over HTTP, same origin (gzip, edge-cached)
        ▼
 frontend/ — static HTML/JS + Canvas, served by the same Vercel project
```

## What I built with, and why

| Piece | Choice | Why |
|---|---|---|
| ETL | **Python**: pyarrow, pandas, Pillow | Parquet is native to pyarrow. Every data fix happens here, once: byte decoding, timestamp units, bot detection, dedupe, coordinate transform. Nothing downstream has to know the raw format. |
| Store | **`store.npz` + `matches.json`** (plus parquet copies for analysts) | Compressed numpy arrays: 34 MB of raw files become under 1 MB, and loading needs nothing but numpy. The pipeline also writes the same data as parquet for notebooks, but the API never reads it. |
| Backend | **FastAPI + numpy only, all in memory** | 89k rows fits in a few MB of RAM. Each query is a vectorised mask plus `bincount`, at about 1–5 ms. Validation, typed params and interactive docs (`/api/docs`) come free. No database, and no pandas or pyarrow at runtime, so the function bundle is about 40 MB. |
| Frontend | **Vanilla ES modules + Canvas 2D, no build step** | The hard part is drawing thousands of points, paths and a heatmap at 60 fps, which Canvas does directly. A framework or bundler would add tooling without helping with that. |
| Hosting | **One Vercel project** | Static CDN for the UI and a Python function for the API on the same origin: no CORS, no second service, no environment variables. Because the runtime needs only numpy and loads under a megabyte of data, cold starts are quick, and responses are edge-cached (the data never changes between deploys). |

## Data flow and responsibilities

* **Pipeline** (`pipeline/build.py`). Reads every file and skips and logs unreadable ones (all 1,243 read). It decodes `event` bytes, strips `.nakama-0`, flags bots by `user_id`, converts `ts`, computes `t` (seconds since the match's first event), drops duplicate movement samples and maps (x, z) → (u, v). It also writes the data-quality report.
* **Backend** (`backend/app/store.py`) handles all filtering and aggregation:
  * the match catalogue: filter by map, days, search and 2+ players; sort; per-day counts; summary totals
  * replay assembly: per-player paths and events, time-ordered
  * heatmaps: a 256×256 **count grid** for any layer, day set, humans/bots, single match or "first N seconds"
  * overview event points
  * `summary`: KPIs, how runs end and when players die, from a per-journey table built at startup
  * `zones`: per-zone (8×8) traffic, loot, kills, deaths and storm with a rule-based design tag (killzone, safe farm, storm trap, quiet, balanced)
  * `flow`: zone-to-zone crossings (consecutive position samples of one journey in different zones), counted both as crossings and as distinct runs. Drives the animated Flow layer and the inspector's arrive-from / leave-to lists
  * every map-level query accepts a time window (`t_min`, `t_max`), dates, humans/bots and a single match
* **Frontend** (`frontend/src/`) is five sections (Briefing, Map Lab, Replay, Compare, Design Radar), each a module in `views/` with its **own filter bar**, mounted by a small hash router in `app.js`. They share a reusable map canvas (`mapview.js`) and a small UI kit (`ui.js`). Presentation only: blur and colour the heat grid, draw paths, markers and heads, run playback, pan and zoom, hover, and keep the view in the URL. Responses are cached per URL, and stale replies (from fast clicking) are discarded.

## Coordinate mapping

The README gives a per-map `scale` and `origin`. I map in **normalised UV space**, never in pixels:

```
u = (x − originX) / scale          v = (z − originZ) / scale        (y = elevation, ignored for 2D)
screenX = mapLeft + u · mapSize    screenY = mapTop + (1 − v) · mapSize     ← v flipped: image rows run downward
heat cell = (⌊(1 − v)·256⌋, ⌊u·256⌋)                                           (backend/app/store.py)
```

The UV step is done once, in the pipeline. The frontend camera (`frontend/src/view.js`) only scales UV to the on-screen map size. **This matters** because the README says the minimaps are 1024×1024 but they are actually **4320², 2160×2158 and 9000²**. Using the README's `·1024` against the real images would squash every point into a corner.

I verified the mapping three ways:
1. All 88,894 points fall inside [0, 1] UV, so there are zero out-of-bounds points (the report and a test assert this).
2. Plotting every sample on each minimap puts paths on roads, bridges and building interiors, never in water or the black void.
3. The README's worked example (−301.45, −355.55 → px 78, 890) reproduces exactly.

## Assumptions where the data was ambiguous

| What I found | How I handled it |
|---|---|
| `ts` is typed `timestamp[ms]`, but read as ms every match is under 1 s long and dated 1970-01-21. The raw integers are Unix **seconds** (they decode to Feb 10–14 2026, matching the folders). | Treat the raw int as seconds. Matches run a median of about 6 min and up to about 15 min. |
| Bots should emit only `BotPosition`, but numeric IDs `1379`, `1402` and `1429` also log `Position`/`Loot` (751 rows). | Human vs bot comes from the file's `user_id`, as the README defines, never from the event name. A test enforces this. |
| `BotKill`/`BotKilled` also appear in bot files. | An event belongs to its file's owner. In a bot's file, `BotKilled` means *this bot died*. Tooltips are worded accordingly. |
| 1,505 exact duplicate rows. | Drop the 210 duplicate *movement* samples. Keep the 1,295 duplicate `Loot`/kill rows, since several pickups in one tick is plausible. |
| 779 of 796 matches contain exactly **one** human file. Only 3 human-vs-human kills exist. | Replays show what was recorded. The "2+ players" filter surfaces the fuller matches. Overview heatmaps aggregate across matches, which is where the signal is. |
| There is no extraction event. | A human journey with no death is labelled "no death" and treated as a *likely* extraction in the insights. |
| Position is sampled about every 5 s, with gaps up to 518 s. | Gaps over 30 s are drawn as breaks, and playback interpolates only within a gap. |
| One match straddles midnight across two day folders. | Each match belongs to its start day (stored on every event), so a day filter never splits a match. |
| Grand Rift's minimap is 2160×2158. | Stretched to 2048² (0.1 % distortion, under a pixel). |

## Major trade-offs

| Decision | Considered | Chose, and why |
|---|---|---|
| Static JSON files vs an API | v1 of this project pre-baked JSON for a static site | **Separate API**. Filtering and aggregation live in one tested place. The frontend stays thin and payloads shrink: a gzipped heat grid is 1–40 KB instead of 1.3 MB of raw points. New queries don't need a rebuild, and other tools (notebooks, dashboards) can use the same endpoints. The cost is a second service to host. |
| Query engine | DuckDB, SQLite, Postgres | **In-memory numpy**. The data is about 90k rows, so a database adds ops for no speed gain. DuckDB over the same parquet is the upgrade path if the data grows 100×. |
| Where heatmaps are computed | Client binning; pre-rendered PNGs | **Server bins, client smooths and colours**. Counts are data and are filterable server-side. Blur, colour ramp and opacity are presentation, adjusted instantly in the browser. |
| Overview scrubbing cost | Request a heat grid for every frame | Quantise `t_max` to 5 s steps and cache by URL. Playback triggers about 1 cheap request per step, and responses stay ordered. |
| Frontend framework | React + Vite; Streamlit | **Vanilla JS + Canvas**. Streamlit can't do smooth playback or pan and zoom, and React adds a build chain without solving rendering. |
| Raw data in git | Commit the 34 MB dump | Only the derived store (about 3 MB) is committed. `build.py` regenerates it deterministically. |
