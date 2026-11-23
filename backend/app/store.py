"""
In-memory query layer over the processed store produced by pipeline/build.py.

The only runtime dependency is numpy: the whole dataset (~89k events) is a handful of arrays, so every query is a
vectorised mask or bincount (typically 1-5 ms), the bundle stays small enough for a serverless function, and cold
starts are fast. Events are stored sorted by (match, player, time), which several queries rely on.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from functools import cached_property
from pathlib import Path

import numpy as np

HEAT_N = 256          # heatmap grid resolution (cells per side)
MOVEMENT_CODES = (0, 1)
CATEGORY_CODES = {"kill": (2, 4), "death": (3, 5), "storm": (6,), "loot": (7,)}
HEAT_LAYERS = {"traffic": (0, 1), "kill": (2, 4), "death": (3, 5, 6), "storm": (6,), "loot": (7,)}
COUNT_COLS = ["Kill", "Killed", "BotKill", "BotKilled", "KilledByStorm", "Loot"]
SORTS = ("players", "action", "long", "recent")
DEATH_CODES = (3, 5, 6)
Z = 8  # zone grid (A-H x 1-8), the same grid the UI overlays


@dataclass(frozen=True)
class Filters:
    """Filters shared by every map-level query. `match` narrows to one match and overrides map/days."""
    map: str
    days: tuple[str, ...] | None = None
    humans: bool = True
    bots: bool = True
    match: str | None = None
    t_max: float | None = None
    t_min: float | None = None


class Store:
    def __init__(self, data_dir: Path):
        data_dir = Path(data_dir)
        self.meta = json.loads((data_dir / "meta.json").read_text())
        self.matches: list[dict] = json.loads((data_dir / "matches.json").read_text())
        self._match_pos = {m["id"]: i for i, m in enumerate(self.matches)}
        self._maps = list(self.meta["maps"])
        self._days = list(self.meta["days"])

        z = np.load(data_dir / "store.npz")
        self._users = z["users"]
        self._match_i = z["match"].astype(np.int64)
        self._user_i = z["user"].astype(np.int64)
        self._bot = z["bot"].astype(bool)
        self._map_i = z["map"].astype(np.int64)
        self._day_i = z["day"].astype(np.int64)
        self._t = z["t"]
        self._code = z["code"]
        self._u = z["u"]
        self._v = z["v"]
        n = len(self._t)

        gx = np.minimum(HEAT_N - 1, (self._u * HEAT_N).astype(np.int32))
        gy = np.minimum(HEAT_N - 1, ((1 - self._v) * HEAT_N).astype(np.int32))  # image rows run downward
        self._cell = gy * HEAT_N + gx
        # 8x8 zone index (row-major, row 0 = north), for zone analytics
        self._z8 = (np.minimum(Z - 1, ((1 - self._v) * Z).astype(np.int32)) * Z
                    + np.minimum(Z - 1, (self._u * Z).astype(np.int32))).astype(np.int64)
        self._mi = self._match_i

        # a journey is a run of equal (match, player); rows are stored sorted so these runs are contiguous
        new = np.ones(n, dtype=bool)
        new[1:] = (self._match_i[1:] != self._match_i[:-1]) | (self._user_i[1:] != self._user_i[:-1])
        self._ji = np.cumsum(new) - 1
        first = np.flatnonzero(new)
        self._jmatch, self._jmap, self._jday, self._jbot = (a[first] for a in (self._match_i, self._map_i, self._day_i, self._bot))
        # how each journey ended: its first death event (code, time); -1 = never died
        dead = np.flatnonzero(np.isin(self._code, DEATH_CODES))
        jd, at = np.unique(self._ji[dead], return_index=True)
        self._jdeath_code = np.full(len(first), -1, dtype=np.int64)
        self._jdeath_t = np.zeros(len(first), dtype=np.int64)
        self._jdeath_code[jd] = self._code[dead[at]]
        self._jdeath_t[jd] = self._t[dead[at]]

        # row indices belonging to each match
        order = np.argsort(self._match_i, kind="stable")
        bounds = np.concatenate([[0], np.cumsum(np.bincount(self._match_i, minlength=len(self.matches)))])
        self._rows = [order[bounds[i]:bounds[i + 1]] for i in range(len(self.matches))]

    @cached_property
    def _user(self) -> np.ndarray:
        """Per-event player id strings (only built when needed, e.g. by tests)."""
        return self._users[self._user_i]

    # ------------------------------------------------------------------ helpers
    def has_map(self, map_id: str) -> bool:
        return map_id in self.meta["maps"]

    def has_match(self, match_id: str) -> bool:
        return match_id in self._match_pos

    def _day_ids(self, days) -> list[int]:
        return [self._days.index(d) for d in days if d in self._days]

    def _mask(self, f: Filters, codes=None) -> np.ndarray:
        if f.match:
            m = np.zeros(len(self._t), dtype=bool)
            pos = self._match_pos.get(f.match)
            if pos is not None:
                m[self._rows[pos]] = True
        else:
            m = self._map_i == self._maps.index(f.map)
            if f.days is not None:
                m &= np.isin(self._day_i, self._day_ids(f.days))
        if not f.humans:
            m &= self._bot
        if not f.bots:
            m &= ~self._bot
        if f.t_max is not None:
            m &= self._t <= f.t_max
        if f.t_min is not None:
            m &= self._t >= f.t_min
        if codes is not None:
            m &= np.isin(self._code, codes)
        return m

    def _matches_for(self, map_id: str, days) -> list[dict]:
        return [m for m in self.matches if m["map"] == map_id and (days is None or m["day"] in days)]

    # ------------------------------------------------------------------ queries
    def list_matches(self, map_id: str, days=None, q: str = "", sort: str = "players",
                     multi_only: bool = False, limit: int = 400) -> dict:
        day_counts: dict[str, int] = {}
        for m in self.matches:
            if m["map"] == map_id:
                day_counts[m["day"]] = day_counts.get(m["day"], 0) + 1
        ms = self._matches_for(map_id, days)
        total = len(ms)
        summary = {c: sum(m["counts"][c] for m in ms) for c in COUNT_COLS}
        t_max = max((m["dur"] for m in ms), default=0)
        if multi_only:
            ms = [m for m in ms if m["humans"] + m["bots"] > 1]
        q = q.strip().lower()
        if q:
            ms = [m for m in ms if q in m["id"] or any(q in p for p in m["playerIds"])]
        combat = lambda m: sum(m["counts"][c] for c in ("Kill", "Killed", "BotKill", "BotKilled", "KilledByStorm"))  # noqa: E731
        key = {
            "players": lambda m: (-(m["humans"] + m["bots"]), -combat(m)),
            "action": lambda m: -combat(m),
            "long": lambda m: -m["dur"],
            "recent": lambda m: -m["start"],
        }[sort]
        ms = sorted(ms, key=key)  # stable: ties keep chronological order
        rows = [{k: m[k] for k in ("id", "day", "start", "dur", "humans", "bots", "counts")} for m in ms[:limit]]
        return {"map": map_id, "total": total, "filtered": len(ms), "dayCounts": day_counts,
                "summary": summary, "tMax": int(t_max), "matches": rows}

    def get_match(self, match_id: str) -> dict | None:
        pos = self._match_pos.get(match_id)
        if pos is None:
            return None
        meta = self.matches[pos]
        players: dict[str, dict] = {}
        for i in self._rows[pos]:  # rows are already ordered by player, then time
            uid = str(self._users[self._user_i[i]])
            p = players.setdefault(uid, {"id": uid, "bot": bool(self._bot[i]), "path": [], "events": []})
            t, code, u, v = int(self._t[i]), int(self._code[i]), round(float(self._u[i]), 4), round(float(self._v[i]), 4)
            if code in MOVEMENT_CODES:
                p["path"] += [t, u, v]
            else:
                p["events"].append([t, code, u, v])
        return {
            "id": match_id, "map": meta["map"], "day": meta["day"], "start": meta["start"], "dur": meta["dur"],
            "humans": meta["humans"], "bots": meta["bots"], "counts": meta["counts"],
            "players": sorted(players.values(), key=lambda p: (p["bot"], p["id"])),
        }

    def heatmap(self, f: Filters, layer: str) -> dict:
        """Sparse N x N count grid (row-major, row 0 = north). Smoothing/colouring is a presentation concern."""
        m = self._mask(f, HEAT_LAYERS[layer])
        counts = np.bincount(self._cell[m], minlength=HEAT_N * HEAT_N)
        nz = np.flatnonzero(counts)
        return {"n": HEAT_N, "layer": layer, "total": int(m.sum()), "cells": nz.tolist(), "counts": counts[nz].tolist()}

    def events(self, f: Filters) -> dict:
        """Discrete (non-movement) events as columnar arrays, for markers. Match ids are dictionary-encoded."""
        m = self._mask(f, [c for codes in CATEGORY_CODES.values() for c in codes])
        used, inv = np.unique(self._match_i[m], return_inverse=True)
        return {
            "count": int(m.sum()),
            "u": np.round(self._u[m], 4).tolist(), "v": np.round(self._v[m], 4).tolist(),
            "code": self._code[m].tolist(), "bot": self._bot[m].astype(int).tolist(), "t": self._t[m].tolist(),
            "matchIds": [self.matches[i]["id"] for i in used], "match": inv.tolist(),
        }

    # ------------------------------------------------------------------ dashboards
    def summary(self, f: Filters) -> dict:
        """Headline numbers for one map: KPIs, how runs end, and when players die."""
        ms = self._matches_for(f.map, f.days)
        sel = (self._jmap == self._maps.index(f.map)) & np.where(self._jbot, f.bots, f.humans)
        if f.days is not None:
            sel &= np.isin(self._jday, self._day_ids(f.days))
        died = sel & (self._jdeath_code >= 0)
        code, dt = self._jdeath_code[died], self._jdeath_t[died]
        combat = np.isin(code, (3, 5))
        nb = int(dt.max() // 60) + 1 if len(dt) else 1
        b = np.minimum(nb - 1, dt // 60)
        by_code = np.bincount(self._code[self._mask(Filters(map=f.map, days=f.days, humans=f.humans, bots=f.bots))], minlength=8)
        med = lambda x: float(np.median(x)) if len(x) else None  # noqa: E731
        return {
            "map": f.map, "matches": int(len(np.unique(self._jmatch[sel]))), "journeys": int(sel.sum()),
            "t_max": int(max((m["dur"] for m in ms), default=0)),
            "kpis": {"kills": int(by_code[2] + by_code[4]), "deaths": int(by_code[3] + by_code[5]),
                     "storm": int(by_code[6]), "loot": int(by_code[7])},
            "outcomes": {"combat": int(combat.sum()), "storm": int((code == 6).sum()),
                         "survived": int((self._jdeath_code[sel] < 0).sum())},
            "median_death_t": {"combat": med(dt[combat]), "storm": med(dt[~combat])},
            "death_hist": {"bin": 60, "combat": np.bincount(b[combat], minlength=nb).tolist(),
                           "storm": np.bincount(b[~combat], minlength=nb).tolist()},
        }

    @staticmethod
    def _tag(t_share, risk, reward, deaths, loot, storm, s_share) -> str:
        if t_share == 0:
            return "none"
        if storm >= 2 and s_share >= 0.15:
            return "storm"
        if t_share < 0.01:
            return "quiet"
        if risk >= 1.5 and deaths >= 5:
            return "kill"
        if reward >= 1.2 and risk <= 0.6 and loot >= 20:
            return "farm"
        return "neutral"

    def zones(self, f: Filters) -> dict:
        """Per-zone (8x8) traffic / loot / combat stats with a rule-based design tag for each zone."""
        m = self._mask(f)
        z, code = self._z8[m], self._code[m]
        count = lambda codes: np.bincount(z[np.isin(code, codes)], minlength=Z * Z)  # noqa: E731
        traffic, loot, kills = count((0, 1)), count((7,)), count((2, 4))
        deaths, storm = count(DEATH_CODES), count((6,))
        mov = np.isin(code, (0, 1))
        visits = np.bincount(np.unique(self._mi[m][mov] * (Z * Z) + z[mov]) % (Z * Z), minlength=Z * Z)
        n_matches = int(len(np.unique(self._mi[m])))
        share = lambda a: a / max(1, a.sum())  # noqa: E731
        ts, ls, ks, ds, ss = (share(a) for a in (traffic, loot, kills, deaths, storm))
        cells = []
        for i in range(Z * Z):
            col, row = i % Z, i // Z
            risk = float(ds[i] / ts[i]) if ts[i] > 0 else None
            reward = float(ls[i] / ts[i]) if ts[i] > 0 else None
            cells.append({
                "i": i, "id": f"{'ABCDEFGH'[col]}{row + 1}", "col": col, "row": row,
                "traffic": int(traffic[i]), "visits": int(visits[i]), "loot": int(loot[i]), "kills": int(kills[i]),
                "deaths": int(deaths[i]), "storm": int(storm[i]),
                "tShare": round(float(ts[i]), 4), "lShare": round(float(ls[i]), 4), "kShare": round(float(ks[i]), 4),
                "dShare": round(float(ds[i]), 4), "sShare": round(float(ss[i]), 4),
                "risk": None if risk is None else round(risk, 2), "reward": None if reward is None else round(reward, 2),
                "tag": self._tag(ts[i], risk, reward, int(deaths[i]), int(loot[i]), int(storm[i]), ss[i]),
            })
        return {"n": Z, "matches": n_matches, "cells": cells,
                "totals": {"traffic": int(traffic.sum()), "loot": int(loot.sum()), "kills": int(kills.sum()),
                           "deaths": int(deaths.sum()), "storm": int(storm.sum())}}

    def flow(self, f: Filters) -> dict:
        """
        Zone-to-zone movement: how often players crossed from one 8x8 zone into another.
        Consecutive position samples of the same journey that fall in different zones form one crossing.
        `runs` counts distinct journeys, so a player pacing back and forth doesn't inflate an edge.
        """
        idx = np.flatnonzero(self._mask(f, MOVEMENT_CODES))
        z, j = self._z8[idx], self._ji[idx]
        step = (j[1:] == j[:-1]) & (z[1:] != z[:-1])
        key = z[:-1][step] * (Z * Z) + z[1:][step]
        keys, n = np.unique(key, return_counts=True)
        pairs = np.unique(np.stack([key, j[:-1][step]], axis=1), axis=0) if len(key) else np.empty((0, 2), dtype=np.int64)
        runs = dict(zip(*np.unique(pairs[:, 0], return_counts=True))) if len(pairs) else {}
        order = np.argsort(-n, kind="stable")
        edges = [{"from": int(keys[i] // (Z * Z)), "to": int(keys[i] % (Z * Z)), "n": int(n[i]), "runs": int(runs[keys[i]])} for i in order]
        return {"n": Z, "crossings": int(n.sum()), "edges": edges}
