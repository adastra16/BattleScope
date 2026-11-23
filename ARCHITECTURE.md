# Architecture

**Raw parquet → ETL → numpy store → FastAPI → canvas UI**, all in one Vercel project (static frontend + a Python function on the same origin).

```
player_data/ (1,243 parquet files)  →  pipeline/build.py (offline, once)
   → backend/data/store.npz + matches.json + meta.json (<1 MB)   frontend/minimaps/*.jpg (2048², static)
   → backend/ FastAPI: /api/{meta, maps/{map}/matches|heatmap|events|summary|zones|flow, matches/{id}}
   → frontend/ vanilla JS + Canvas: five sections, each with its own filters
```

## Stack and why
| Piece | Choice | Why |
|---|---|---|
| ETL | Python (pyarrow, pandas, Pillow) | Every data quirk is fixed once, offline. Nothing downstream sees the raw format. |
| Store | `store.npz` + `matches.json` (parquet copy for analysts) | 34 MB of files become under 1 MB; the API needs only numpy. |
| API | FastAPI + numpy, all in memory | 89k rows fit in RAM. Each query is a vectorised mask or `bincount` (1–5 ms), so there is no database and cold starts are small. |
| UI | Vanilla ES modules + Canvas 2D, no build step | The hard part is drawing thousands of points, paths and a heatmap at 60 fps. A framework adds tooling without helping. |

## Data flow
1. **Pipeline** decodes event bytes, flags bots by `user_id`, treats `ts` as seconds, drops duplicate movement samples, maps `(x, z)` to minimap UV and resizes the minimaps. It also writes the data-quality report.
2. **API** does all filtering and aggregation (map, dates, humans/bots, match, time window): match list, replay paths, heat grids, event points, KPIs, per-zone stats and zone-to-zone flow.
3. **UI** only presents: it smooths and colours the heat grid, draws paths and markers, runs playback and keeps the view in the URL.

## Coordinate mapping
The README gives a scale and origin per map. I map into **normalised UV space**, never pixels:

```
u = (x − originX) / scale        v = (z − originZ) / scale        (y is elevation, ignored in 2D)
screenX = mapLeft + u · size     screenY = mapTop + (1 − v) · size     (v flipped: image rows run downward)
```
The UV step happens once, in the pipeline, so the image's pixel size never enters the maths. That matters because the README says the minimaps are 1024², but they are **4320², 2160×2158 and 9000²**; using `·1024` would squash every point into a corner. Checked three ways: all 88,894 points fall inside [0, 1] (a test asserts it); plotting every sample puts paths on roads and buildings, never in water or void; and the README's worked example (−301.45, −355.55 → px 78, 890) reproduces exactly.

## Assumptions where the data was ambiguous
| Found | Handled |
|---|---|
| `ts` is typed ms but every match is under 1 s long | The integers are Unix **seconds** (they decode to Feb 10–14 2026). Matches run about 6 min, up to 15. |
| 3 numeric (bot) IDs also log `Position`/`Loot` | Human vs bot comes from the file's `user_id`, never the event name. |
| `BotKilled` also appears in bot files | An event belongs to its file's owner: in a bot's file it means that bot died. |
| 1,505 duplicate rows | Drop the 210 duplicate movement samples; keep the 1,295 duplicate loot/kill rows (several pickups per tick is plausible). |
| 779 of 796 matches hold one human; only 3 human-vs-human kills | Replay shows what was recorded; aggregate views carry the signal. "2+ players" finds fuller matches. |
| No extraction event | A run with no death is treated as a likely extraction, and labelled so. |
| Sampling about every 5 s, gaps up to 518 s | Gaps over 30 s draw as breaks, not lines; playback interpolates inside gaps only. |
| One match spans two day folders | It belongs to the day it started. |
| Zone types (meat grinder, loot buffet…) | Simple rules in `backend/app/store.py` (`_tag`), e.g. deaths ≥ 1.5× fair share with ≥ 5 deaths. They are heuristics, not facts. |

## Major trade-offs
| Decision | Considered | Chose, and why |
|---|---|---|
| Precomputed JSON vs API | Static JSON per match and map | **API.** Filters live in one tested place and payloads stay small (a heat grid is 1–40 KB). Costs one function. |
| Query engine | DuckDB, SQLite, Postgres | **In-memory numpy.** About 90k rows; a database adds ops for no speed. DuckDB is the upgrade path at 100× the data. |
| Runtime deps | pandas + pyarrow in the function | **numpy only.** Keeps the function about 40 MB with fast cold starts; pandas stays in the offline pipeline. |
| Heatmaps | Client binning; pre-rendered PNGs | **Server counts, client smooths.** Counts follow every filter; colour and opacity change instantly. |
| Hosting | Separate API host + static host | **One Vercel project.** Same origin, no CORS, no env vars. |
| Frontend | React + Vite, Streamlit | **Vanilla JS + Canvas.** Streamlit can't do smooth playback or pan/zoom; React adds a build chain without solving rendering. |
