# Insights

All numbers come from **human journeys** (781 player-match files from 245 human players). They are reproducible with `python -I pipeline/insights.py backend/data`. Locations use the in-app **Grid** overlay (columns A–H run west→east, rows 1–8 run north→south). Every claim can be checked in the tool by choosing a map, turning on Grid and picking the named heatmap.

---

## 1. Ambrose Valley's central core takes over half of all deaths, while the southern towns pay out loot almost for free

**What caught my eye.** With the *Deaths* heatmap on Ambrose Valley, one red mass sits in the centre of the map. With the *Loot* heatmap, the southern settlements light up just as brightly but have almost no death markers.

**Evidence** (554 human journeys on Ambrose Valley):

| Zone | Share of movement | Share of loot | Share of human deaths | Share of kills |
|---|---|---|---|---|
| Central core: **C4, C5, D4, D5** (4 of 64 cells) | 24 % | 24 % | **51 %** | 48 % |
| Southern/western towns: **C7, E7, A4** | 13 % | **19 %** | **1 %** | 6 % |

* C5 alone accounts for 18 % of human deaths. In C4 and C5, deaths per loot pickup run about 2.4× the map average (13 % of deaths vs 5.5 % of loot in C4; 18 % vs 7.5 % in C5).
* 98 % of the core's deaths (158 of 162) are `BotKilled`, so the core is where **bots** are concentrated and lethal. Humans also land 48 % of their kills there.
* Median time to a bot death is **4 min 30 s**, so the core is a mid-match choke, not a landing zone.

**Is it actionable? Yes.**
* *Levers:* spread bot spawns and patrol routes out of C4–D5; add cover or alternate routes through the river crossing; move some high-tier loot from E7 and C7 towards the centre (or vice versa) so risk and reward line up.
* *Metrics affected:* human death rate (currently 53 % of journeys end in a bot kill), extraction / "no death" rate (43 %), deaths per loot pickup by zone, and session length before first death.

**Why a level designer should care.** Players currently see one dominant "go here and probably die" route and a few "safe farm" towns. Either the map's intended risk/reward isn't reading, or bot placement is doing the level's job for it. Both can be fixed with layout and spawn tuning, without systems changes.

---

## 2. Lockdown kills players with the storm 3× more often than Ambrose Valley, and they die mid-map, not at the edge

**What caught my eye.** Switching the *Storm* heatmap between maps: Lockdown has as many storm deaths as Ambrose Valley (17 each) from a third as many journeys. The violet markers sit in the middle of the map, not along a border.

**Evidence:**

| Map | Human journeys | Storm deaths | Storm-death rate | Median time of storm death | Median match length |
|---|---|---|---|---|---|
| Ambrose Valley | 554 | 17 | **3 %** | 12:10 | 6:02 |
| Lockdown | 170 | 17 | **10 %** | 12:41 | 7:28 |
| Grand Rift | 57 | 5 | 9 % (small sample) | 11:56 | 7:02 |

* On Lockdown, storm deaths cluster in **F4, E4, E3, G4** (the central-east buildings). The mean position is u = 0.55, v = 0.54, the centre of the playable area.
* Storm deaths all happen late (Lockdown 25th–75th percentile 12:16 to 13:20; Ambrose Valley 11:50 to 12:51). These are players who stayed too long, not players caught by an early storm.
* Lockdown is labelled the "smaller / close-quarters" map, yet it has the *longest* matches.

**Is it actionable? Yes.**
* *Levers:* shorten traversal from the F4/E4 building cluster to the nearest extraction, add a second extraction or more visible extraction signposting on the far side from the storm, and audit how early the storm's direction is communicated on Lockdown.
* *Metrics affected:* storm-death rate per map (target close to Ambrose Valley's 3 %), extraction rate, late-match survival, and the share of players dying with unextracted loot. That last one feels the worst to players and drives churn.

**Why a level designer should care.** A storm death is a *navigation* failure, not a combat one. Players lose the run without being outplayed. When it happens 3× more on one map, at the same late timestamp, in the same interior buildings, the cause is that map's geometry and extraction placement.

---

## 3. A third of the ground players actually reach on Ambrose Valley is barely used

**What caught my eye.** The *Traffic* heatmap on Ambrose Valley has a bright core and dark fringes. The east (column F) and the southern edge (row 8) have roads and buildings on the minimap but almost no paths.

**Evidence** (554 journeys, ~35k position samples):
* Human movement touches 39 of the 64 grid cells, but **8 cells carry 50 %** of all movement and the top 5 carry 38 %. **13 of those 39 cells (a third) each get < 1 %**.
* 9 cells with visible map content each get **< 0.5 %** of movement. **F6** and **F7** (east-side buildings) are entered in only 28 and 25 of 554 journeys (about 5 %). **B8, D8, E8** along the south edge are visited by 12, 11 and 2 journeys.
* The same pattern on the other maps: Lockdown uses 29/64 cells and 7 of them carry half the movement. Grand Rift uses 36/64 cells and 8 carry half.

**Is it actionable? Yes.**
* *Levers:* pull players outward with a loot or objective anchor in F6/F7 and on the south road. Or cut the dead space, so the storm and fights compress into the areas players actually use. Check whether the east side is cut off by sight lines or the river crossing.
* *Metrics affected:* map-coverage % (cells with ≥ 1 % of traffic), entropy of player routes, encounter spacing (fewer forced fights in C4–D5, which ties into Insight 1), and per-zone loot-pickup rate.

**Why a level designer should care.** Unused space is art and design budget that players never experience, and it pushes the remaining players into the over-contested core. Tracking coverage before and after a layout change is a cheap, objective test of whether the change worked. This tool shows that coverage directly.

---

*Caveat on all three:* 779 of 796 matches contain a single human's telemetry, so these are patterns across many solo journeys, not full-lobby reconstructions. "No death" is treated as a likely extraction because the data has no extraction event.
