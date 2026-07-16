# agentic-sls — SLS printer process control + build knowledge

This MCP server (`agentic-sls`) controls a SLS4All Inova MK1 SLS printer
mid-print through the Inova-API-Plugin (default `http://192.168.1.146:5001`,
override with `INOVA_API_BASE_URL`), and answers questions about past builds
from the recorder's Postgres (`DATABASE_URL`, read-only; the data tools
error with instructions if unset).

## Control tools (live printer)

| Tool | Effect |
|---|---|
| `printer_status` | Read-only: layer progress, temperatures, power, positions, recoater override state. |
| `recoater_passes_get` / `recoater_passes_set` | Staged powder delivery WITHIN one layer (1/N per pass + finishing pass). |
| `recoater_full_passes_get` / `recoater_full_passes_set` | Expand each layer into N full recoat cycles (optionally dry). |
| `layer_overrides_get` / `layer_overrides_set` | Runtime knob registry: recoater speeds, shake, powder dosing, Z clearance, delays. |

## Knowledge tools (recorder database, read-only)

| Tool | Effect |
|---|---|
| `builds_list` | Catalog of recorded builds (incl. failures) with profile, session outcome, layer counts, ASTM coverage. |
| `build_get` | One build card: session/job/profile linkage, key profile parameters, telemetry summary, per-batch ASTM outcomes. |
| `astm_query` | Mechanical results (D638 tensile / D790 flex), grouped by batch/profile/material or per-specimen. |
| `telemetry_summary` | Derived telemetry for one build: thermal tracking error, recoat timeline, laser duty. |
| `db_query` | Single read-only SELECT for anything the curated tools don't cover (schema hint in the tool description). |
| `reference_list` / `reference_get` | Curated reference corpus (`datasets/Agentic-SLS-Knowledge/source/`): material TDS values, Fuse 1 ↔ Inova translation, profile conventions. |

Every `*_set` call is logged server-side to the `agent_actions` table
(timestamped onto the telemetry timeline) — this is expected behavior, not
surveillance to work around; it is how past interventions become queryable
evidence for future decisions.

Typical flow for parameter questions: `astm_query` grouped by profile for the
parameters-to-properties picture, `builds_list --has_astm` for the evidence
builds, `build_get` to drill into one.

## Ground rules

- Set-tools mutate a **live print**. Changes take effect on the **next
  layer** — verify there, not on the current layer.
- Staged passes and full-recoat passes are different mechanisms; never treat
  them as interchangeable.
- Always call `layer_overrides_get` before `layer_overrides_set` — knob names
  and ranges come from the firmware registry, not from assumptions.
- `layer_overrides_set` is all-or-nothing; one bad entry rejects the batch.
- Clear overrides with `null` rather than writing assumed defaults; profile
  values differ between prints. Clean up leftover overrides — saved state
  survives firmware config reloads.
- If `recoater_full_passes_get` reports `replacementActive: false`, the
  full-recoat override is a no-op; report that instead of assuming success.
- TimeSpan knobs are fractional seconds; factor knobs multiply the profile
  value (1.0 = neutral); temperatures are °C.
