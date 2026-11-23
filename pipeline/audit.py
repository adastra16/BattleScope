"""
Independent data audit: recompute headline numbers straight from the RAW parquet dump (no shared code with build.py)
and compare them with what the running API reports. Exits non-zero on any mismatch.

Usage:  python -I pipeline/audit.py <path/to/player_data> [api_base=http://localhost:8000]
"""
import json, os, re, sys, urllib.request
import pandas as pd
import pyarrow.parquet as pq

root = sys.argv[1]
base = (sys.argv[2] if len(sys.argv) > 2 else "http://localhost:8000").rstrip("/") + "/api"
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")

frames = []
for day in sorted(d for d in os.listdir(root) if d.startswith("February_")):
    for f in os.listdir(os.path.join(root, day)):
        df = pq.read_table(os.path.join(root, day, f)).to_pandas()
        frames.append(df)
raw = pd.concat(frames, ignore_index=True)
raw["event"] = raw["event"].map(lambda b: b.decode() if isinstance(b, bytes) else b)
raw["match"] = raw.match_id.str.replace(r"\.nakama-\d+$", "", regex=True)
raw["is_bot"] = ~raw.user_id.str.match(UUID.pattern)
raw["sec"] = raw.ts.astype("int64")  # 'ts' holds Unix seconds despite its ms type

get = lambda p: json.load(urllib.request.urlopen(base + p))
bad = 0
def check(name, raw_v, api_v):
    global bad
    ok = raw_v == api_v
    bad += not ok
    print(f"  {'OK ' if ok else 'BAD'} {name}: raw={raw_v} api={api_v}")

DEATHS = ["Killed", "BotKilled", "KilledByStorm"]
# map calibration copied from the dataset README (deliberately NOT imported from build.py)
CAL = {"AmbroseValley": (900, -370, -473), "GrandRift": (581, -290, -290), "Lockdown": (1000, -500, -500)}
for m in ["AmbroseValley", "GrandRift", "Lockdown"]:
    r = raw[raw.map_id == m]; h = r[~r.is_bot]
    s, z = get(f"/maps/{m}/summary?bots=false"), get(f"/maps/{m}/zones?bots=false")
    print(m)
    check("human runs", h.groupby(["match", "user_id"]).ngroups, s["journeys"])
    check("matches containing a human", h.match.nunique(), s["matches"])
    check("same match count in zones", h.match.nunique(), z["matches"])
    check("matches recorded (any file)", r.match.nunique(), len(get(f"/maps/{m}/matches?limit=2000")["matches"]))
    check("human kills (Kill+BotKill)", int(h.event.isin(["Kill", "BotKill"]).sum()), s["kpis"]["kills"])
    check("human loot pickups", int((h.event == "Loot").sum()), s["kpis"]["loot"])
    check("storm deaths", int((h.event == "KilledByStorm").sum()), s["kpis"]["storm"])
    first = h[h.event.isin(DEATHS)].sort_values("sec", kind="stable").groupby(["match", "user_id"]).head(1)
    check("runs ending in combat", int(first.event.isin(["Killed", "BotKilled"]).sum()), s["outcomes"]["combat"])
    check("runs ending in storm", int((first.event == "KilledByStorm").sum()), s["outcomes"]["storm"])
    check("runs with no death", h.groupby(["match", "user_id"]).ngroups - len(first), s["outcomes"]["survived"])
    check("zone loot total", int((h.event == "Loot").sum()), z["totals"]["loot"])
    check("zone death events", int(h.event.isin(DEATHS).sum()), z["totals"]["deaths"])
    check("zone traffic <= raw positions", z["totals"]["traffic"] <= int((h.event == "Position").sum()), True)
    check("zone traffic shares sum to 1", round(sum(c["tShare"] for c in z["cells"])), 1)
    # flow: recount zone-to-zone crossings from raw positions
    sc, ox, oz = CAL[m]
    p = h[h.event == "Position"].assign(sec=lambda d: d.sec).sort_values(["match", "user_id", "sec"], kind="stable")
    col = ((p.x - ox) / sc * 8).clip(0, 7.999).astype(int); row = ((1 - (p.z - oz) / sc) * 8).clip(0, 7.999).astype(int)
    zone = (row * 8 + col).to_numpy(); jr = (p.match + "|" + p.user_id).to_numpy()
    cross = int(((jr[1:] == jr[:-1]) & (zone[1:] != zone[:-1])).sum())
    check("flow crossings", cross, get(f"/maps/{m}/flow?bots=false")["crossings"])
print("\nALL CHECKS PASSED" if not bad else f"\n{bad} MISMATCH(ES)")
sys.exit(1 if bad else 0)
