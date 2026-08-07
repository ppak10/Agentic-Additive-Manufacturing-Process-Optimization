---
name: print-profiles
description: >
  Read, create, and edit SLS4All Inova print profiles (process parameters:
  laser energy, temperatures, layer/recoater settings). Use when the user
  wants to adjust process parameters, create a profile for a material or
  experiment, compare profiles, or match parameters to a material TDS.
---

# Print profiles

A profile is a sparse DELTA over the system Default: null/absent fields
inherit. Profiles are inert until a job that uses them is printed — creating
or editing one never changes a running print.

## Tools

- `profile_list` — id, name, isDefault, modifiedAt (file mtime — the
  reliable date).
- `profile_get` — one profile's fields. `merged=true` resolves inheritance
  to EFFECTIVE values — always adapt from merged values.
- `profile_set` — upsert: create (no `profile_id`, `name` required,
  optional `base_profile_id` to copy from) or partial update.

## Hard rules

- **Profile names lie.** A "20mJ/mm" profile may contain 15. Read fields
  via `profile_get merged=true`; never trust a name.
- The system **Default is read-only** — every profile inherits from it;
  `profile_set` refuses it. Create a new profile instead.
- **Field bounds in the `profile_set` schema are printer-safety limits**,
  not suggestions (temperatures cap at 200 °C by deliberate choice). If a
  TDS or calculation wants more, SAY SO — never clamp silently.
- **Thickness fields are MICROMETERS** (`layerThickness` 100,
  `bedPreparationThickness` 13000). Delay fields are seconds.
- Ground parameter choices in evidence: `reference_get` for the material
  TDS / Fuse 1 ↔ Inova translation, `astm_query` grouped by profile for the
  parameters-to-properties picture, `build_get` for how a profile actually
  behaved.

## Naming & debug conversations

- In a debug-flagged conversation, every profile you create is
  automatically prefixed `[DEBUG]` (server-enforced) so the operator can
  find and delete test content later. Mention the final name when
  reporting.
- Name profiles for their intent and provenance (material, energy point,
  date) — and remember the name is a label, not documentation; the fields
  are the truth.

## Artifact panel

- A profile you create is auto-pinned to the conversation's artifact panel
  (provenance `created`) — the operator sees its key fields card
  immediately, with a link to edit it on the Print Profiles page.
- When DISCUSSING an existing profile (baseline candidates, comparisons),
  pin it with `artifact_add type=profile` so the operator has it on screen.
  Browsing via `profile_list`/`profile_get` deliberately pins nothing.
- Curate: `artifact_list` shows the pinned set + the operator's focused
  tab; `artifact_remove` clears tabs that are no longer relevant.

## Workflow: new parameter set → test build

1. Baseline: `profile_get merged=true` on the closest existing profile.
2. `profile_set` — create from `base_profile_id`, changing only the fields
   the experiment is about; report old → new for each.
3. Instantiate a blessed `[TEMPLATE]` job with the new profile via
   `job_create_from_template` (see the stored-jobs skill).
4. The operator reviews and starts the print — never you.
