# agentic-sls — SLS printer process control

This MCP server (`agentic-sls`) controls a SLS4All Inova MK1 SLS printer
mid-print through the Inova-API-Plugin (default `http://192.168.1.146:5001`,
override with `INOVA_API_BASE_URL`).

## Tools

| Tool | Effect |
|---|---|
| `printer_status` | Read-only: layer progress, temperatures, power, positions, recoater override state. |
| `recoater_passes_get` / `recoater_passes_set` | Staged powder delivery WITHIN one layer (1/N per pass + finishing pass). |
| `recoater_full_passes_get` / `recoater_full_passes_set` | Expand each layer into N full recoat cycles (optionally dry). |
| `layer_overrides_get` / `layer_overrides_set` | Runtime knob registry: recoater speeds, shake, powder dosing, Z clearance, delays. |

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
