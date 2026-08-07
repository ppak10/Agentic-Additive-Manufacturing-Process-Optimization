---
name: recoater-control
description: >
  Adjust recoater behavior and layer parameters on the SLS4All Inova during a
  live print — staged recoater passes, full-recoat expansion, and the runtime
  layer-override knobs (speeds, shake, powder dosing, Z clearance, delays).
  Use when the user asks to change recoating, powder delivery, or layer
  parameters mid-print, or when telemetry suggests a recoat quality problem.
---

# Recoater control (mid-print)

All tools here mutate a **live print**. Changes always take effect on the
**next layer** — the current layer's plan is already committed — so verify a
change by watching the following layer, not the current one.

## The two "passes" concepts — do not confuse them

1. **Staged passes** (`recoater_passes_set`, 1–5): the firmware's *Thickness
   division* mode. N passes each deliver **1/N of one layer's powder**, plus a
   finishing pass. Total powder is unchanged; delivery is gentler. Use for
   powder-spreading quality issues (streaks, short feeds) where the layer
   height should stay the same.

2. **Full-recoat passes** (`recoater_full_passes_set`, 1–5): expands each
   layer into **N complete recoat cycles** via the FullRecoatLayerClient
   substitution. Each repeat doses fresh powder unless `powder=false` (dry
   sweeps). Use when a layer needs genuinely more powder coverage or thermal
   settling between sweeps.
   - Check `replacementActive` in the response. If `false`, the LayerClient
     substitution is not loaded and the override is a **no-op** — report this
     to the user rather than assuming the change applied.

## Workflow

1. `printer_status` — confirm a build is active, note current layer, and read
   the existing override state.
2. `layer_overrides_get` — the authoritative knob registry: names, kinds,
   min/max, live value, saved override, and `profileValue` (the running print
   profile's baseline). A knob with `saved: null` is running at profile value.
3. Make the smallest change that addresses the problem, one knob at a time
   when diagnosing. `layer_overrides_set` is all-or-nothing: the firmware
   validates the whole batch before applying, so a bad name/range rejects the
   entire request.
4. Verify on the next layer (via `printer_status` or telemetry) and report
   what changed: old value → new value, and when it takes effect.
5. To revert, set the knob(s) to `null` — this clears the override back to
   the profile value. Saved overrides persist across firmware config reloads,
   so leftover overrides outlive the moment; clean up when done.

## Laser energy and temperatures mid-print (setup overrides)

Recoating mechanics are `layer_overrides_*`; **laser energy and phase
temperature targets are a separate channel**: `setup_overrides_get` /
`setup_overrides_set` (the firmware's native mid-print tuning surface).
Knobs: `totalEnergyDensityPercent` (1–500, the global energy scaler — the
cleanest single lever), `laserFillEnergyDensity` (0–100 mJ/mm),
`laserOutlineEnergyDensities` (array, entries 0–100), and the bed-prep /
begin-layer / print-cap temperature targets (0–200 °C, hard policy cap).
Same discipline as layer overrides: read first (`defaults` carries the
running profile's baseline), change take effect next layer, `null` reverts
to profile — but note these are **reset to empty at every print start**
(nothing staged while idle survives), and unlike layer overrides they do
NOT persist across prints.

## Units and conventions

- TimeSpan knobs are **fractional seconds** over the API.
- Factor knobs (`*FactorOverride`) multiply the profile value; `1.0` is
  neutral.
- Temperatures elsewhere in the API are °C.

## Safety

- State the change and which layer it lands on when reporting back.
- Prefer clearing overrides (`null`) over writing "default-looking" values —
  the profile default may differ between prints.
- If the printer is idle (no active build), setup-dependent fields like
  `profileValue`/`profileDefault` read `null`; overrides can still be staged
  but verify intent with the user first.
