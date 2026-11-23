"""
BattleScope ETL: raw LILA BLACK parquet telemetry -> clean, analysis-ready store for the API.

Usage:
    python -I pipeline/build.py <path/to/player_data> [backend_data_dir=backend/data] [frontend_dir=frontend]

Outputs:
    <backend_data_dir>/events.parquet   one row per (deduplicated) event, with match-relative time and minimap UV
    <backend_data_dir>/matches.parquet  one row per match: map, day, start, duration, player counts, event counts
    <backend_data_dir>/meta.json        map config, days, event codes, data-quality report
    <frontend_dir>/minimaps/<map>.jpg   minimaps resized to 2048x2048 (static assets, served by the frontend)
"""
import json
import os
import re
import sys

import pandas as pd
import pyarrow.parquet as pq
from PIL import Image

# README map configuration: world (x, z) -> UV in [0, 1]
MAPS = {
    "AmbroseValley": {"scale": 900, "originX": -370, "originZ": -473, "image": "AmbroseValley_Minimap.png"},
    "GrandRift": {"scale": 581, "originX": -290, "originZ": -290, "image": "GrandRift_Minimap.png"},
    "Lockdown": {"scale": 1000, "originX": -500, "originZ": -500, "image": "Lockdown_Minimap.jpg"},
}
MINIMAP_OUT_PX = 2048

# Stable integer codes shared with the frontend (public/src/constants.js)
EVENT_CODES = {
    "Position": 0, "BotPosition": 1, "Kill": 2, "Killed": 3,
    "BotKill": 4, "BotKilled": 5, "KilledByStorm": 6, "Loot": 7,
}
MOVEMENT = {"Position", "BotPosition"}
UUID_RE = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$", re.I)


def decode(v):
    return v.decode("utf-8") if isinstance(v, (bytes, bytearray)) else str(v)


def load(root):
    frames, bad = [], []
    days = sorted(d for d in os.listdir(root) if d.startswith("February_") and os.path.isdir(os.path.join(root, d)))
    for day in days:
        folder = os.path.join(root, day)
        for name in sorted(os.listdir(folder)):
            if name.startswith("."):
                continue
            path = os.path.join(folder, name)
            try:
                df = pq.read_table(path).to_pandas()
            except Exception as e:  # corrupt / non-parquet file: skip but record it
                bad.append({"file": f"{day}/{name}", "error": str(e)[:120]})
                continue
            df["day"] = day
            frames.append(df)
    df = pd.concat(frames, ignore_index=True)
    return df, days, bad, len(frames)


def transform(df):
    report = {"rows_raw": int(len(df))}
    df["event"] = df["event"].map(decode)
    df["match_id"] = df["match_id"].str.replace(r"\.nakama-\d+$", "", regex=True)
    # Bot vs human: decided by the file owner's user_id (UUID = human, numeric = bot), NOT by event name,
    # because a few bot files contain 'Position'/'Loot' events.
    df["is_bot"] = ~df["user_id"].str.match(UUID_RE.pattern)
    # 'ts' is typed timestamp[ms] but the integer actually holds Unix *seconds* (decodes to 1970-01-21 as ms,
    # to Feb 10-14 2026 as seconds - matching the folder dates). Treat raw int as seconds.
    df["sec"] = df["ts"].astype("int64")

    unknown = sorted(set(df["event"]) - set(EVENT_CODES))
    report["unknown_events"] = unknown
    df = df[df["event"].isin(EVENT_CODES)].copy()

    # Duplicate movement samples carry no information -> drop. Duplicate Loot/kill rows at the same tick are
    # kept: multiple pickups in a single tick are plausible and we'd rather not under-count.
    key = ["user_id", "match_id", "sec", "event", "x", "z"]
    dup = df.duplicated(key) & df["event"].isin(MOVEMENT)
    report["movement_duplicates_dropped"] = int(dup.sum())
    report["non_movement_duplicates_kept"] = int((df.duplicated(key) & ~df["event"].isin(MOVEMENT)).sum())
    df = df[~dup].copy()

    df["u"] = 0.0
    df["v"] = 0.0
    for m, c in MAPS.items():
        sel = df["map_id"] == m
        df.loc[sel, "u"] = (df.loc[sel, "x"] - c["originX"]) / c["scale"]
        df.loc[sel, "v"] = (df.loc[sel, "z"] - c["originZ"]) / c["scale"]
    oob = (df["u"] < 0) | (df["u"] > 1) | (df["v"] < 0) | (df["v"] > 1)
    report["out_of_bounds_points"] = int(oob.sum())
    df["u"] = df["u"].clip(0, 1)
    df["v"] = df["v"].clip(0, 1)

    # Match clock: time relative to the first event of the match (across all its files).
    start = df.groupby("match_id")["sec"].transform("min")
    df["t"] = (df["sec"] - start).astype(int)
    df["code"] = df["event"].map(EVENT_CODES)
    df = df.sort_values(["match_id", "user_id", "sec", "code"], kind="stable").reset_index(drop=True)
    report["rows_clean"] = int(len(df))
    return df, report


def build_matches(df):
    """One row per match. A match that straddles midnight belongs to the day folder it started in."""
    first = df.loc[df.groupby("match_id")["sec"].idxmin(), ["match_id", "day", "map_id"]].set_index("match_id")
    g = df.groupby("match_id")
    m = pd.DataFrame({
        "map": first["map_id"],
        "day": first["day"],
        "start": g["sec"].min(),
        "dur": g["t"].max(),
        "humans": df[~df["is_bot"]].groupby("match_id")["user_id"].nunique(),
        "bots": df[df["is_bot"]].groupby("match_id")["user_id"].nunique(),
    }).fillna({"humans": 0, "bots": 0})
    counts = df[~df["event"].isin(MOVEMENT)].pivot_table(index="match_id", columns="event", values="t", aggfunc="size")
    for ev in EVENT_CODES:
        if ev not in MOVEMENT:
            m[ev] = counts[ev] if ev in counts else 0
    m = m.fillna(0)
    m["player_ids"] = g["user_id"].agg(lambda s: sorted(s.unique().tolist()))
    int_cols = ["start", "dur", "humans", "bots"] + [e for e in EVENT_CODES if e not in MOVEMENT]
    m[int_cols] = m[int_cols].astype("int64")
    return m.reset_index(names="id").sort_values("start").reset_index(drop=True)


def build_events(df, matches):
    day_of = matches.set_index("id")["day"]
    return pd.DataFrame({
        "match_id": df["match_id"].astype("category"),
        "user_id": df["user_id"].astype("category"),
        "is_bot": df["is_bot"].astype(bool),
        "map_id": df["map_id"].astype("category"),
        "day": df["match_id"].map(day_of).astype("category"),  # the match's day, so filters never split a match
        "t": df["t"].astype("int32"),
        "code": df["code"].astype("int8"),
        "u": df["u"].astype("float32"),
        "v": df["v"].astype("float32"),
        "x": df["x"].astype("float32"),
        "y": df["y"].astype("float32"),
        "z": df["z"].astype("float32"),
    })


def build_minimaps(root, out):
    os.makedirs(os.path.join(out, "minimaps"), exist_ok=True)
    sizes = {}
    for m, c in MAPS.items():
        Image.MAX_IMAGE_PIXELS = None  # Lockdown is 9000x9000
        im = Image.open(os.path.join(root, "minimaps", c["image"]))
        sizes[m] = list(im.size)
        # Source images are NOT 1024px as the README says (4320, 2160x2158, 9000). UV mapping is
        # resolution-independent, so we just normalise everything to a square 2048px web image.
        im.convert("RGB").resize((MINIMAP_OUT_PX, MINIMAP_OUT_PX), Image.LANCZOS).save(
            os.path.join(out, "minimaps", f"{m}.jpg"), quality=85, optimize=True, progressive=True)
    return sizes


def main():
    root = sys.argv[1]
    data_out = sys.argv[2] if len(sys.argv) > 2 else os.path.join("backend", "data")
    front_out = sys.argv[3] if len(sys.argv) > 3 else "frontend"
    os.makedirs(data_out, exist_ok=True)

    raw, days, bad, n_files = load(root)
    df, report = transform(raw)
    matches = build_matches(df)
    events = build_events(df, matches)
    events.to_parquet(os.path.join(data_out, "events.parquet"), index=False, compression="zstd")
    matches.to_parquet(os.path.join(data_out, "matches.parquet"), index=False, compression="zstd")
    src_sizes = build_minimaps(root, front_out)

    report |= {
        "files_read": n_files, "files_failed": bad, "matches": len(matches),
        "players": int(df["user_id"].nunique()),
        "humans": int(df.loc[~df["is_bot"], "user_id"].nunique()),
        "bots": int(df.loc[df["is_bot"], "user_id"].nunique()),
        "events_by_owner": {("bot" if b else "human"): {k: int(v) for k, v in g["event"].value_counts().items()}
                            for b, g in df.groupby("is_bot")},
        "matches_with_multiple_files": int(((matches["humans"] + matches["bots"]) > 1).sum()),
        "matches_spanning_two_day_folders": int((raw.groupby("match_id")["day"].nunique() > 1).sum()),
        "source_minimap_sizes": src_sizes,
    }
    meta = {
        "maps": {m: {k: c[k] for k in ("scale", "originX", "originZ")}
                 | {"image": f"minimaps/{m}.jpg", "matchCount": int((matches["map"] == m).sum())}
                 for m, c in MAPS.items()},
        "days": days,
        "eventCodes": EVENT_CODES,
        "report": report,
    }
    with open(os.path.join(data_out, "meta.json"), "w") as f:
        json.dump(meta, f, indent=2)
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
