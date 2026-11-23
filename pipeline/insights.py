"""Reproducible stats behind INSIGHTS.md. Usage: python -I pipeline/insights.py [backend/data]"""
import sys
import numpy as np
import pandas as pd

data = sys.argv[1] if len(sys.argv) > 1 else "backend/data"
ev = pd.read_parquet(f"{data}/events.parquet")
ms = pd.read_parquet(f"{data}/matches.parquet")
G = 8  # same grid as the in-app overlay: columns A-H (west->east), rows 1-8 (north->south)
ev["cell"] = [f"{'ABCDEFGH'[min(G - 1, int(u * G))]}{min(G - 1, int((1 - v) * G)) + 1}" for u, v in zip(ev.u, ev.v)]
DEATH = {3: "Killed", 5: "BotKilled", 6: "KilledByStorm"}
hum = ev[~ev.is_bot]

for m in ["AmbroseValley", "GrandRift", "Lockdown"]:
    h = hum[hum.map_id == m]
    journeys = h.groupby(["match_id", "user_id"], observed=True)
    nJ = journeys.ngroups
    deaths = h[h.code.isin(DEATH)].sort_values("t").groupby(["match_id", "user_id"], observed=True).head(1)
    print(f"\n===== {m}: {(ms["map"] == m).sum()} matches, {nJ} human journeys")
    out = deaths.code.map(DEATH).value_counts().to_dict(); out["no death"] = nJ - len(deaths)
    print("outcome:", {k: f"{v} ({v / nJ:.0%})" for k, v in out.items()})
    for code, name in DEATH.items():
        t = deaths[deaths.code == code].t
        if len(t): print(f"  {name} time s: median {t.median():.0f}, p25 {t.quantile(.25):.0f}, p75 {t.quantile(.75):.0f}")
    pos = h[h.code == 0]
    tr = pos.cell.value_counts(); tot = tr.sum(); cum = tr.cumsum() / tot
    visits = pos.groupby("cell").match_id.nunique()
    print(f"traffic samples {tot}; cells used {len(tr)}/64; top5 {cum.iloc[4]:.0%}; cells for 50% = {int((cum < .5).sum()) + 1}; cells <1% = {(tr / tot < .01).sum()}")
    print("low-traffic cells (<0.5%):", [(c, int(n), int(visits[c])) for c, n in tr[tr / tot < .005].items()])
    share = lambda s: (s.value_counts() / len(s) * 100).round(1)
    kills = share(h[h.code.isin([2, 4])].cell); loot = share(h[h.code == 7].cell); dshare = share(deaths.cell)
    tab = pd.DataFrame({"traffic%": (tr / tot * 100).round(1), "loot%": loot, "death%": dshare, "kill%": kills}).fillna(0)
    print(tab[tab["traffic%"] >= 1].assign(gap=lambda d: d["loot%"] - d["death%"]).sort_values("gap", ascending=False).to_string())
    st = deaths[deaths.code == 6]
    if len(st): print("storm deaths:", st.cell.value_counts().head(6).to_dict(), "mean u/v", round(st.u.mean(), 2), round(st.v.mean(), 2))

core = hum[(hum.map_id == "AmbroseValley") & hum.code.isin(DEATH)].sort_values("t").groupby(["match_id", "user_id"], observed=True).head(1)
core = core[core.cell.isin(["C4", "C5", "D4", "D5"])]
print("\nAmbrose core deaths by cause:", core.code.map(DEATH).value_counts().to_dict())
print("matches per map", ms["map"].value_counts().to_dict())
print("humans per match", ms.humans.value_counts().to_dict())
print("median match duration s", ms.groupby("map").dur.median().to_dict())
