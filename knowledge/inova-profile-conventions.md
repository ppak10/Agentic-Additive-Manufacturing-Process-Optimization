---
title: Inova print profile conventions
summary: How this lab's print profiles are named and structured, which JSON fields matter, and known naming pitfalls. Read before comparing profiles or proposing a new one.
---

# Inova print profile conventions

Profiles live in the firmware (synced to `inova_print_profiles` in Postgres,
full JSON in the `profile` column). One profile ≈ one experiment condition.

## Naming

`YYYY_MM_DD <energy> mJ/mm [variant] Formlabs PA12 GF` — the date is when
the profile was created, the energy is the `LaserFillEnergyDensity` value,
variants describe the deviation being tested ("Higher Temp", "Extended
Cap", "25% Overlap", "100% Recycled", "1 Second Heat Time").

**Pitfall: names can lie.** The profile named "2026_06_06 20mJ/mm" actually
contains `LaserFillEnergyDensity: 15`. Always read the JSON field, never
trust the name — `db_query` on `inova_print_profiles` or
`build_get.profile_key_params`.

## Energy densities tried so far (all at LayerThickness 100 µm)

14, 15, 20, 24, 28, 32, 36, 40 mJ/mm. Low end (14–20) sinters but
underperforms mechanically; 28–36 is the strong region; 40 explores the
upper bound. `LaserFillEnergyDensity` is per mm of scan path — to compare
across layer thicknesses or hatch spacings, normalize to J/mm³.

## Temperature fields (°C) for PA12 GF

- `SurfaceTarget` / `SurfaceTarget2`: powder surface hold (168 / 172
  baseline; Target2 applies after `SurfaceTarget2Time`).
- `HeatingTargetPrint` (172), `BedPreparationTemperatureTarget` (174),
  `BeginLayerTemperatureTarget` (176), `PrintCapTemperatureTarget` (174).
- PA12 melt ≈ 187 °C; these sit 11–19 °C below (the sintering window).

## Other fields that have mattered in experiments

- `HotspotOverlapPercent` (25 baseline; the "25% Overlap" profile varies
  scan overlap), `OutlineCount` (2), `IsFillEnabled`.
- `PrintCapThickness` / "Extended Cap" variants — powder above the last
  layer for thermal mass during cooldown.
- `HeatingMinimumTime` ("1 Second Heat Time" variant collapses it),
  `PowderVolumePercent` (110 = 10% extra dose per recoat),
  `RecoaterPasses`, `RecoaterShakePercent`.
- Durations are TimeSpan strings ("00:45:00"); factor-style runtime
  overrides multiply profile values (1.0 = neutral) — see AGENTS.md ground
  rules for the runtime knob semantics.

## Linking profiles to outcomes

`astm_query {group_by: "profile"}` gives mechanicals per profile;
`builds_list {profile: "36mJ"}` finds the builds that ran it;
`build_get` shows a build's `profile_key_params` and thermal tracking.
