"""API tests against the real processed store. Run: cd backend && pytest -q"""
from fastapi.testclient import TestClient

from app.main import app, get_store

client = TestClient(app)
MAP = "AmbroseValley"


def test_health_and_meta():
    assert client.get("/api/health").json()["status"] == "ok"
    meta = client.get("/api/meta").json()
    assert set(meta["maps"]) == {"AmbroseValley", "GrandRift", "Lockdown"}
    assert meta["maps"]["AmbroseValley"]["scale"] == 900
    assert meta["report"]["out_of_bounds_points"] == 0


def test_match_list_filters_and_sorting():
    all_days = client.get(f"/api/maps/{MAP}/matches").json()
    one_day = client.get(f"/api/maps/{MAP}/matches", params={"days": "February_14"}).json()
    assert one_day["total"] < all_days["total"]
    assert all(m["day"] == "February_14" for m in one_day["matches"])
    longest = client.get(f"/api/maps/{MAP}/matches", params={"sort": "long"}).json()["matches"]
    assert longest[0]["dur"] >= longest[-1]["dur"]
    multi = client.get(f"/api/maps/{MAP}/matches", params={"multi_only": True}).json()["matches"]
    assert all(m["humans"] + m["bots"] > 1 for m in multi)


def test_match_replay_is_time_ordered_and_in_bounds():
    mid = client.get(f"/api/maps/{MAP}/matches").json()["matches"][0]["id"]
    m = client.get(f"/api/matches/{mid}").json()
    assert m["map"] == MAP and m["players"]
    for p in m["players"]:
        ts = p["path"][0::3]
        assert ts == sorted(ts)
        assert all(0 <= x <= 1 for x in p["path"][1::3] + p["path"][2::3])
        assert all(0 <= e[0] <= m["dur"] for e in p["events"])


def test_heatmap_respects_filters():
    full = client.get(f"/api/maps/{MAP}/heatmap", params={"layer": "death"}).json()
    early = client.get(f"/api/maps/{MAP}/heatmap", params={"layer": "death", "t_max": 120}).json()
    humans = client.get(f"/api/maps/{MAP}/heatmap", params={"layer": "death", "bots": False}).json()
    assert full["n"] == 256 and sum(full["counts"]) == full["total"]
    assert early["total"] < full["total"] and humans["total"] < full["total"]


def test_bot_classification_uses_user_id():
    s = get_store()
    numeric = [u for u in set(s._user) if u.isdigit()]
    assert numeric and all(s._bot[s._user == u].all() for u in numeric[:20])


def test_unknown_resources_404():
    assert client.get("/api/maps/Nowhere/heatmap").status_code == 404
    assert client.get("/api/matches/not-a-match").status_code == 404
    assert client.get(f"/api/maps/{MAP}/heatmap", params={"layer": "bogus"}).status_code == 422


def test_summary_is_consistent():
    s = client.get(f"/api/maps/{MAP}/summary", params={"bots": False}).json()
    o = s["outcomes"]
    assert o["combat"] + o["storm"] + o["survived"] == s["journeys"]
    assert sum(s["death_hist"]["combat"]) == o["combat"] and sum(s["death_hist"]["storm"]) == o["storm"]
    one_day = client.get(f"/api/maps/{MAP}/summary", params={"bots": False, "days": "February_14"}).json()
    assert one_day["journeys"] < s["journeys"]


def test_zones_cover_grid_and_tags():
    z = client.get(f"/api/maps/{MAP}/zones", params={"bots": False}).json()
    assert len(z["cells"]) == 64
    assert abs(sum(c["tShare"] for c in z["cells"]) - 1) < 0.01
    tags = {c["tag"] for c in z["cells"]}
    assert {"kill", "farm"} <= tags
    assert all(c["risk"] is None for c in z["cells"] if c["tag"] == "none")


def test_time_window_filters():
    full = client.get(f"/api/maps/{MAP}/heatmap", params={"layer": "traffic"}).json()["total"]
    early = client.get(f"/api/maps/{MAP}/heatmap", params={"layer": "traffic", "t_max": 300}).json()["total"]
    late = client.get(f"/api/maps/{MAP}/heatmap", params={"layer": "traffic", "t_min": 301}).json()["total"]
    assert early + late == full


def test_match_counts_agree_across_endpoints():
    """Every view must report the same number of matches for the same filters (matches that contain a selected player)."""
    for mode in ({"bots": False}, {"humans": False}, {}):
        s = client.get(f"/api/maps/{MAP}/summary", params=mode).json()
        z = client.get(f"/api/maps/{MAP}/zones", params=mode).json()
        assert s["matches"] == z["matches"], mode


def test_flow_is_well_formed_and_filterable():
    fl = client.get(f"/api/maps/{MAP}/flow", params={"bots": False}).json()
    assert fl["edges"] and fl["crossings"] == sum(e["n"] for e in fl["edges"])
    assert all(0 <= e["from"] < 64 and 0 <= e["to"] < 64 and e["from"] != e["to"] for e in fl["edges"])
    assert all(1 <= e["runs"] <= e["n"] for e in fl["edges"])
    assert [e["n"] for e in fl["edges"]] == sorted((e["n"] for e in fl["edges"]), reverse=True)
    early = client.get(f"/api/maps/{MAP}/flow", params={"bots": False, "t_max": 120}).json()
    assert early["crossings"] < fl["crossings"]
