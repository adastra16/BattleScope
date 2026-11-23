"""Initial data-quality exploration for LILA BLACK telemetry. Usage: python -I pipeline/explore.py <player_data_dir>"""
import sys, os, re
import pyarrow.parquet as pq
import pandas as pd

root = sys.argv[1]
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")
frames, bad = [], []
for day in sorted(d for d in os.listdir(root) if d.startswith("February_")):
    for f in os.listdir(os.path.join(root, day)):
        p = os.path.join(root, day, f)
        try:
            df = pq.read_table(p).to_pandas()
        except Exception as e:
            bad.append((p, str(e)[:60])); continue
        df["day"] = day; df["file"] = f
        frames.append(df)
df = pd.concat(frames, ignore_index=True)
print("files read", len(frames), "bad", bad)
print(df.dtypes)
df["event"] = df["event"].map(lambda b: b.decode() if isinstance(b, bytes) else b)
print(df.head(3).to_string())
print("rows", len(df), "players", df.user_id.nunique(), "matches", df.match_id.nunique())
df["is_bot"] = ~df.user_id.str.match(UUID.pattern)
print(pd.crosstab(df.event, df.is_bot))
print("ts raw min/max", df.ts.min(), df.ts.max())
ts_int = df.ts.astype("int64")
print("ts int64 sample", ts_int.head(3).tolist(), "unit", df.ts.dtype)
g = df.groupby("match_id").ts.agg(["min", "max"])
dur = (g["max"] - g["min"]).dt.total_seconds()
print("match duration (as stored units, s):\n", dur.describe())
print("maps per match", df.groupby("match_id").map_id.nunique().max())
print(df.groupby("map_id").match_id.nunique())
print("days per match", df.groupby("match_id").day.nunique().value_counts())
files_per_match = df.groupby("match_id").file.nunique()
print("files per match\n", files_per_match.describe())
hum = df[~df.is_bot].groupby("match_id").user_id.nunique()
bot = df[df.is_bot].groupby("match_id").user_id.nunique()
print("humans/match", hum.describe().to_dict()); print("bots/match", bot.describe().to_dict())
print("dupes", df.duplicated(["user_id","match_id","ts","event","x","z"]).sum())
print("nulls", df.isna().sum().to_dict())
cfg = {"AmbroseValley": (900,-370,-473), "GrandRift": (581,-290,-290), "Lockdown": (1000,-500,-500)}
for m,(s,ox,oz) in cfg.items():
    d = df[df.map_id==m]; u=(d.x-ox)/s; v=(d.z-oz)/s
    print(m, "u", round(u.min(),3), round(u.max(),3), "v", round(v.min(),3), round(v.max(),3), "oob", ((u<0)|(u>1)|(v<0)|(v>1)).sum(), "y", d.y.min(), d.y.max())
# match_id vs filename
fm = df.file.str.split("_", n=1).str[1]
print("filename match == match_id:", (fm == df.match_id).mean(), "filename user == user_id:", (df.file.str.split("_",n=1).str[0]==df.user_id).mean())
df.to_pickle(sys.argv[2]) if len(sys.argv) > 2 else None
