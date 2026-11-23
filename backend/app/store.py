"""
In-memory query layer over the clean parquet store produced by pipeline/build.py.

The whole dataset (~89k events) fits comfortably in memory, so every query is a vectorised numpy mask
over pre-extracted column arrays — typically well under 10 ms. No database needed at this scale.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np
import pandas as pd

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
        ev = pd.read_parquet(data_dir / "events.parquet")
        self.matches = pd.read_parquet(data_dir / "matches.parquet").set_index("id", drop=False)

        # Column arrays for fast masking
        self._map = ev["map_id"].astype(str).to_numpy()
        self._day = ev["day"].astype(str).to_numpy()
        self._match = ev["match_id"].astype(str).to_numpy()
        self._user = ev["user_id"].astype(str).to_numpy()
        self._bot = ev["is_bot"].to_numpy()
        self._t = ev["t"].to_numpy()
        self._code = ev["code"].to_numpy()
        self._u = ev["u"].to_numpy()
        self._v = ev["v"].to_numpy()
        gx = np.minimum(HEAT_N - 1, (self._u * HEAT_N).astype(np.int32))
        gy = np.minimum(HEAT_N - 1, ((1 - self._v) * HEAT_N).astype(np.int32))  # image rows run downward
        self._cell = gy * HEAT_N + gx
        self._rows_by_match = {k: np.asarray(v) for k, v in ev.groupby("match_id", observed=True).indices.items()}
        # 8x8 zone index (row-major, row 0 = north) and an integer match id, for zone analytics
        self._z8 = (np.minimum(Z - 1, ((1 - self._v) * Z).astype(np.int32)) * Z
                    + np.minimum(Z - 1, (self._u * Z).astype(np.int32)))
        self._mi = pd.factorize(self._match)[0]
        self.journeys = self._build_journeys(ev)
        # integer id per (match, player) journey; rows are stored sorted by journey then time, which `flow` relies on
        self._ji = pd.factorize(pd.Series(self._match) + "|" + pd.Series(self._user))[0]

    # ------------------------------------------------------------------ helpers
    def has_map(self, map_id: str) -> bool:
        return map_id in self.meta["maps"]

    def has_match(self, match_id: str) -> bool:
        return match_id in self._rows_by_match

    def _mask(self, f: Filters, codes=None) -> np.ndarray:
        if f.match:
            m = np.zeros(len(self._t), dtype=bool)
            m[self._rows_by_match.get(f.match, [])] = True
        else:
            m = self._map == f.map
            if f.days is not None:
                m &= np.isin(self._day, f.days)
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

    def _matches_for(self, map_id: str, days):
        ms = self.matches[self.matches["map"] == map_id]
        return ms if days is None else ms[ms["day"].isin(days)]

    # ------------------------------------------------------------------ queries
    def list_matches(self, map_id: str, days=None, q: str = "", sort: str = "players",
                     multi_only: bool = False, limit: int = 400) -> dict:
        all_on_map = self.matches[self.matches["map"] == map_id]
        day_counts = all_on_map["day"].value_counts().to_dict()
        ms = self._matches_for(map_id, days)
        total = len(ms)
        summary = {c: int(ms[c].sum()) for c in COUNT_COLS}
        t_max = int(ms["dur"].max()) if len(ms) else 0
        if multi_only:
            ms = ms[(ms["humans"] + ms["bots"]) > 1]
        q = q.strip().lower()
        if q:
            hit = ms["id"].str.contains(q, regex=False) | ms["player_ids"].map(lambda ids: any(q in p for p in ids))
            ms = ms[hit]
        combat = ms["Kill"] + ms["Killed"] + ms["BotKill"] + ms["BotKilled"] + ms["KilledByStorm"]
        keys = {
            "players": [ms["humans"] + ms["bots"], combat],
            "action": [combat],
            "long": [ms["dur"]],
            "recent": [ms["start"]],
        }[sort]
        order = np.lexsort([-k.to_numpy() for k in reversed(keys)])
        ms = ms.iloc[order]
        rows = [
            {"id": r.id, "day": r.day, "start": int(r.start), "dur": int(r.dur), "humans": int(r.humans),
             "bots": int(r.bots), "counts": {c: int(getattr(r, c)) for c in COUNT_COLS}}
            for r in ms.head(limit).itertuples()
        ]
        return {"map": map_id, "total": total, "filtered": len(ms), "dayCounts": day_counts,
                "summary": summary, "tMax": t_max, "matches": rows}

    def get_match(self, match_id: str) -> dict | None:
        idx = self._rows_by_match.get(match_id)
        if idx is None:
            return None
        meta = self.matches.loc[match_id]
        order = idx[np.lexsort((self._code[idx], self._t[idx], self._user[idx]))]
        players: dict[str, dict] = {}
        for i in order:
            uid = self._user[i]
            p = players.setdefault(uid, {"id": uid, "bot": bool(self._bot[i]), "path": [], "events": []})
            t, code, u, v = int(self._t[i]), int(self._code[i]), round(float(self._u[i]), 4), round(float(self._v[i]), 4)
            if code in MOVEMENT_CODES:
                p["path"] += [t, u, v]
            else:
                p["events"].append([t, code, u, v])
        return {
            "id": match_id, "map": meta["map"], "day": meta["day"], "start": int(meta["start"]),
            "dur": int(meta["dur"]), "humans": int(meta["humans"]), "bots": int(meta["bots"]),
            "counts": {c: int(meta[c]) for c in COUNT_COLS},
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
        match_ids, m_idx = np.unique(self._match[m], return_inverse=True)
        return {
            "count": int(m.sum()),
            "u": np.round(self._u[m], 4).tolist(), "v": np.round(self._v[m], 4).tolist(),
            "code": self._code[m].tolist(), "bot": self._bot[m].astype(int).tolist(), "t": self._t[m].tolist(),
            "matchIds": match_ids.tolist(), "match": m_idx.tolist(),
        }

    # ------------------------------------------------------------------ dashboards
    @staticmethod
    def _build_journeys(ev: pd.DataFrame) -> pd.DataFrame:
        """One row per (match, player): map, day, bot?, how it ended (first death) and when."""
        e = ev.assign(match_id=ev["match_id"].astype(str), user_id=ev["user_id"].astype(str),
                      map_id=ev["map_id"].astype(str), day=ev["day"].astype(str))
        keys = ["match_id", "user_id"]
        j = e.groupby(keys).agg(map=("map_id", "first"), day=("day", "first"), bot=("is_bot", "first"))
        dead = e[e["code"].isin(DEATH_CODES)].sort_values("t", kind="stable").groupby(keys).head(1).set_index(keys)
        j["death_code"] = dead["code"].reindex(j.index).fillna(-1).astype(int)
        j["death_t"] = dead["t"].reindex(j.index)
        return j.reset_index()  # keeps match_id / user_id as columns

    def summary(self, f: Filters) -> dict:
        """Headline numbers for one map: KPIs, how runs end, and when players die."""
        ms = self._matches_for(f.map, f.days)
        j = self.journeys
        sel = (j["map"] == f.map) & np.where(j["bot"], f.bots, f.humans)
        if f.days is not None:
            sel &= j["day"].isin(f.days)
        js = j[sel]
        dead = js[js["death_code"] >= 0]
        combat = dead["death_code"].isin((3, 5)).to_numpy()
        nb = int(dead["death_t"].max() // 60) + 1 if len(dead) else 1
        b = np.minimum(nb - 1, (dead["death_t"] // 60).astype(int).to_numpy())
        by_code = np.bincount(self._code[self._mask(Filters(map=f.map, days=f.days, humans=f.humans, bots=f.bots))], minlength=8)
        med = lambda x: float(np.median(x)) if len(x) else None  # noqa: E731
        dt = dead["death_t"].to_numpy()
        return {
            "map": f.map, "matches": int(js["match_id"].nunique()), "journeys": int(len(js)),
            "t_max": int(ms["dur"].max()) if len(ms) else 0,
            "kpis": {"kills": int(by_code[2] + by_code[4]), "deaths": int(by_code[3] + by_code[5]),
                     "storm": int(by_code[6]), "loot": int(by_code[7])},
            "outcomes": {"combat": int(combat.sum()), "storm": int((dead["death_code"] == 6).sum()),
                         "survived": int((js["death_code"] < 0).sum())},
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
        key = z[:-1][step].astype(np.int64) * (Z * Z) + z[1:][step]
        keys, n = np.unique(key, return_counts=True)
        pairs = np.unique(np.stack([key, j[:-1][step]], axis=1), axis=0) if len(key) else np.empty((0, 2), dtype=np.int64)
        runs = dict(zip(*np.unique(pairs[:, 0], return_counts=True))) if len(pairs) else {}
        order = np.argsort(-n, kind="stable")
        edges = [{"from": int(keys[i] // (Z * Z)), "to": int(keys[i] % (Z * Z)), "n": int(n[i]), "runs": int(runs[keys[i]])} for i in order]
        return {"n": Z, "crossings": int(n.sum()), "edges": edges}
