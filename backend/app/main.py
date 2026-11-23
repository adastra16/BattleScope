"""BattleScope API — read-only HTTP layer over the telemetry store."""
from __future__ import annotations

import os
from functools import lru_cache
from pathlib import Path
from typing import Literal

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware

from .store import HEAT_LAYERS, SORTS, Filters, Store

DATA_DIR = Path(os.getenv("DATA_DIR", Path(__file__).resolve().parent.parent / "data"))
CORS_ORIGINS = [o.strip() for o in os.getenv("CORS_ORIGINS", "*").split(",") if o.strip()]

app = FastAPI(
    title="BattleScope API",
    version="1.0.0",
    description="Player journeys, combat, loot and storm events from LILA BLACK telemetry.",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    redoc_url=None,
)
app.add_middleware(CORSMiddleware, allow_origins=CORS_ORIGINS, allow_methods=["GET"], allow_headers=["*"])
app.add_middleware(GZipMiddleware, minimum_size=1024)


@lru_cache(maxsize=1)
def get_store() -> Store:
    return Store(DATA_DIR)


def _days(days: str | None) -> tuple[str, ...] | None:
    return None if days is None else tuple(d for d in days.split(",") if d)


def map_filters(
    map_id: str,
    days: str | None = Query(None, description="Comma-separated day folders, e.g. February_10,February_11. Omit for all."),
    humans: bool = True,
    bots: bool = True,
    match: str | None = Query(None, description="Restrict to one match (overrides days)."),
    t_max: float | None = Query(None, ge=0, description="Only events at or before this many seconds into the match."),
    t_min: float | None = Query(None, ge=0, description="Only events at or after this many seconds into the match."),
    store: Store = Depends(get_store),
) -> Filters:
    if not store.has_map(map_id):
        raise HTTPException(404, f"Unknown map '{map_id}'")
    if match and not store.has_match(match):
        raise HTTPException(404, f"Unknown match '{match}'")
    return Filters(map=map_id, days=_days(days), humans=humans, bots=bots, match=match, t_max=t_max, t_min=t_min)


@app.get("/api/health")
def health(store: Store = Depends(get_store)):
    return {"status": "ok", "matches": len(store.matches)}


@app.get("/api/meta")
def meta(store: Store = Depends(get_store)):
    """Map configuration (scale/origin/minimap), available days, event codes and the data-quality report."""
    return store.meta


@app.get("/api/maps/{map_id}/matches")
def list_matches(
    map_id: str,
    days: str | None = None,
    q: str = Query("", max_length=64, description="Substring of a match id or player id"),
    sort: Literal[SORTS] = "players",  # type: ignore[valid-type]
    multi_only: bool = False,
    limit: int = Query(400, ge=1, le=2000),
    store: Store = Depends(get_store),
):
    if not store.has_map(map_id):
        raise HTTPException(404, f"Unknown map '{map_id}'")
    return store.list_matches(map_id, _days(days), q, sort, multi_only, limit)


@app.get("/api/matches/{match_id}")
def get_match(match_id: str, store: Store = Depends(get_store)):
    """Full replay: every player's path [t, u, v, ...] and events [t, code, u, v], t in seconds from match start."""
    m = store.get_match(match_id)
    if m is None:
        raise HTTPException(404, f"Unknown match '{match_id}'")
    return m


@app.get("/api/maps/{map_id}/heatmap")
def heatmap(
    layer: Literal[tuple(HEAT_LAYERS)] = "traffic",  # type: ignore[valid-type]
    f: Filters = Depends(map_filters),
    store: Store = Depends(get_store),
):
    return store.heatmap(f, layer)


@app.get("/api/maps/{map_id}/events")
def events(f: Filters = Depends(map_filters), store: Store = Depends(get_store)):
    return store.events(f)



@app.get("/api/maps/{map_id}/summary")
def summary(f: Filters = Depends(map_filters), store: Store = Depends(get_store)):
    """KPIs, how runs end, and when players die, for the selected map / days / players."""
    return store.summary(f)


@app.get("/api/maps/{map_id}/zones")
def zones(f: Filters = Depends(map_filters), store: Store = Depends(get_store)):
    """8x8 zone analytics (traffic, loot, kills, deaths, storm) with a rule-based design tag per zone."""
    return store.zones(f)


@app.get("/api/maps/{map_id}/flow")
def flow(f: Filters = Depends(map_filters), store: Store = Depends(get_store)):
    """Zone-to-zone crossings (the player 'highways'), strongest first."""
    return store.flow(f)
