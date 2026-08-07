---
name: powder-tuning
description: >
  Characterise a new powder on the SLS4All Inova with the firmware's
  powder-tuning session: a grid of test patches (default 5×5), each sintered
  with different laser parameters, on a bed of the candidate material. Use
  when the user wants to try a material that has never been printed on this
  printer, mentions a new/unknown/recycled powder, or asks how to find laser
  parameters for an uncharacterised material.
---

# Powder tuning (new-material characterisation)

The session sinters small patches at varied laser parameters so the operator
can inspect which settings fuse the powder well. It is NOT a print: no job,
no parts, no recorder build. **The operator must start the session from the
firmware wizard on the printer (`/wizard/powder-tuning`) — there is no start
tool.** Every powder-tuning tool except `powder_tuning_status` fails with
"no powder tuning session is active" until then.

## Before the session — ground the plan in evidence

1. `reference_list` / `reference_get` — pull the material's TDS if the corpus
   has it (or the closest analogue, e.g. the Fuse 1 ↔ Inova translation).
   You need: melt temperature, suggested bed/surface temperature, and any
   known energy-density starting point.
2. `builds_list` / `db_query` — check whether this or a similar powder was
   attempted before; prior `agent_actions` rows from old tuning sessions are
   queryable (`tool LIKE 'powder_tuning%'`; columns are `ts`, `tool`,
   `arguments`, `result`, `is_error` — there is no `created_at`).
3. `profile_list` / `profile_get merged=true` — pick the closest existing
   profile as the parameter baseline. Profile NAMES lie; read the fields.
4. **The session needs a print profile attached at wizard start** — it is
   where the session's baseline (laser energy, temperatures, recoater) comes
   from; `powder_tuning_print_setup` reads it back. For a NEW powder, do not
   point the wizard at an existing material's profile: create a dedicated
   one with `profile_set` (from the closest baseline via `base_profile_id`,
   named for the new material, e.g. "<Material> powder tuning <date>").
   **The profile must carry the FULL heating chain, not just laser values**
   — the wizard seeds ALL session heating from it: `surfaceTarget` /
   `surfaceTarget2` (the surface hold the patches sinter at) plus the
   chamber/bed targets (`heatingTarget*`, bed-prep and layer temps). A
   fresh new-material profile with these unset or inherited from the wrong
   material heats to the wrong hold — set them from the TDS BEFORE the
   session starts, and read the result back with `profile_get merged=true`
   to confirm nothing is zero/missing (the wizard only lists profiles that
   pass firmware validation). Tell the operator which profile to select in
   the wizard — you cannot start the session yourself.
5. **Give the operator a wizard checklist** — these are operator-entered
   wizard fields you cannot set, and wrong values waste the session:
   - **Extra powder depth MUST be > 0** (wizard default is 0 mm!). With 0
     there is no powder budget — bed leveling and add-layer fail with "not
     enough powder remaining (0.00 μm)".
   - If the machine is already warm from a previous attempt, suggest
     "No gradual heating" to skip the slow ramp.
   - The starting bed/chamber and surface "limit" fields cap the initial
     heat-up below the profile targets — useful to start low and ramp up
     manually while probing an unknown powder.
6. Agree the patch plan with the operator BEFORE sintering (see below).

## Procedure

1. `artifact_add type=powder_tuning id=session` — pin the live tuning view to
   the conversation panel first, so the operator watches what you do.
2. `powder_tuning_status` — confirm the session is active; read `gridDim`
   (patches are row-major `0..gridDim²-1`). **The wizard start is
   two-stage:** first an initial heat-up under `mode: "AnalyseHeating"`
   (`isActive` still false, tools still refused, `surfaceTarget` visibly
   ramping) — that means the wizard IS running, not that the operator
   hasn't started it; report the ramp and wait. `isActive` flips true when
   the firmware enters powder-testing. **Also check `powderDepth`: if it
   is 0, the wizard was started without a powder budget and bed leveling /
   layering will fail ("not enough powder remaining") — tell the operator to
   restart the wizard with a powder depth before going further.**
3. `powder_tuning_bed_level` — level the bed once at session start.
4. `powder_tuning_add_layer` — spread fresh powder. `layer_thickness_um`
   defaults to 100; use a THICKER layer when the surface is rough or a
   sintered patch stands proud, or the recoater drags material across the
   bed.
5. `powder_tuning_set_surface` — set the surface temperature target agreed
   from the TDS (hard cap 200 °C; 0 = heater off). The call returns when the
   target is ACCEPTED, not reached — poll `powder_tuning_status` until
   `surfaceTargetReached` is true (possibly many minutes from cold; warn
   the operator about the wait) and don't sinter before then.
6. `powder_tuning_print_setup` — read the effective laser baseline the
   patches will inherit.
7. Per patch: `powder_tuning_select_patch {grid_index}` then
   `powder_tuning_print_patch {explicit parameters}`. The response is the
   setup ACTUALLY used — report it per patch; that mapping is the whole
   product of the session.
8. Patches are spatially separate, so several patches can be sintered on one
   prepared surface. Spread a fresh layer (`add_layer`) before re-sintering
   a used position or if the surface is disturbed.
9. `powder_tuning_stop` — only when the operator confirms the plan is done
   (firmware handles cap-and-cool; there is no restart tool).

## Designing the patch plan

- Default shape: a single-variable sweep of `total_energy_density_percent`
  around the baseline profile's value (e.g. rows step energy, columns repeat
  or step a second variable such as `laser_fill_speed_xy`). One variable per
  axis; never vary more than two things across one grid.
- Anchor the range on evidence (TDS energy-density hints, the baseline
  profile, prior sessions) — propose it, with the numbers, and get the
  operator's yes before the first `print_patch`.
- Always pass parameters EXPLICITLY to `print_patch`; omitted fields fall
  back to profile values silently.
- Hotspot overlap (`hotspot_overlap_percent`), outline power increase
  (`outline_power_increase`) and fill outline skip
  (`fill_outline_skip_count`) are per-patch `print_patch` parameters — do
  NOT edit the session's profile mid-run to change them; that mutates
  shared state and its effect on an already-running session is not
  guaranteed. Confirm the echoed values in the response.
- Keep `print_number_enabled` on so patches are physically labeled.
- Patches the operator fires from the wizard GUI never appear in
  `agent_actions` — watch for jumps in `printLabelIndex` from
  `select_patch` responses and ask the operator what they fired, so the
  final patch → parameter table stays complete.

## Artifact panel

- The `powder_tuning` artifact (pinned in step 1, and auto-pinned by any
  successful mutating call) shows the operator a LIVE view: session status,
  the patch grid with what you've sintered (replayed from `agent_actions`),
  and the chamber camera. Keep it pinned for the whole session.
- Also pin what the session is grounded in: the baseline profile
  (`artifact_add type=profile`) and, if you're comparing against a past
  build, that build (`type=build`). The operator should be able to follow
  the whole experiment from the panel without asking.
- `artifact_list` reports which tab the operator is focused on; use
  `artifact_remove` to clear tabs that stop being relevant.

## After the session

- The firmware saves a session report named after the wizard's "report name"
  (default `powders-<date>`) into the documents folder on the printer —
  point the operator at it.
- Summarise the patch → parameters table (grid index, energy density, power,
  speed) for the operator, who inspects the physical patches.
- Translate the winning patch into a candidate profile with `profile_set`
  (create from the baseline profile), then `job_create_from_template` for a
  first real test build. Creating is fine; ONLY the operator starts prints.
- In a debug-flagged conversation, profiles/jobs you create are
  automatically named with a `[DEBUG]` prefix (server-enforced) so test
  content is easy to find and delete later — mention the final names when
  reporting.

## Safety

- `print_patch` fires the laser. That is acceptable ONLY because the operator
  started the wizard session — never work around the no-session error.
- Temperature bounds (≤200 °C) are hard safety limits, not suggestions; if
  the TDS implies more, say so instead of clamping silently.
- Long calls (`add_layer`, `print_patch`, `bed_level`) block on physical
  operations. If a call times out harness-side, the printer operation may
  still complete — re-check `powder_tuning_status` before retrying.
- Every call is logged to `agent_actions`; the conversation panel's grid is
  reconstructed from that log. Keep your own patch bookkeeping consistent
  with what the responses returned, not what you intended to send.
