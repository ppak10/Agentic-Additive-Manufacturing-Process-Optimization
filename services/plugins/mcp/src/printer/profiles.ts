import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { withActionLog } from "../actions.js";
import { errorResult, jsonResult } from "../result.js";

// Print-profile tools — live CRUD against the plugin's /profiles routes.
// A profile is a sparse DELTA over the system Default: null/absent fields
// inherit. profile_set is an upsert (create when no profile_id, update
// otherwise) and never touches the system Default profile itself.
//
// Validation is two-layer: the zod schema below bakes the allowed range
// into every field (so the model sees limits up front and bad calls fail
// locally with a named message), and the plugin enforces the same bounds
// server-side for every caller. Keep both tables in sync
// (PrintProfileEndpoints.cs `_bounds`).
//
// Responses are PROJECTED to the surfaced fields — the raw profile JSON
// carries a ~250 KB `stats` blob that must never enter model context.

const MATERIALS = ["NotSet", "PA11", "PA12", "TPU", "Custom1", "Custom2", "Custom3", "Custom4", "Custom5"] as const;

// Numeric fields with enforced bounds (mirror of the plugin's _bounds).
const NUM_FIELDS: { key: string; unit?: string; min: number; max: number }[] = [
  // Thickness fields are MICROMETERS (live data: layer 100, bedPrep 13000)
  { key: "layerThickness", unit: "µm", min: 50, max: 300 },
  { key: "recoaterPasses", min: 1, max: 10 },
  { key: "recoaterPowderSpeedPercent", unit: "%", min: 1, max: 200 },
  { key: "recoaterPrintSpeedPercent", unit: "%", min: 1, max: 200 },
  { key: "heatingTargetPowder", unit: "°C", min: 0, max: 200 },
  { key: "heatingTargetPrint", unit: "°C", min: 0, max: 200 },
  { key: "heatingTargetPrintBed", unit: "°C", min: 0, max: 200 },
  { key: "heatingRate", min: 0, max: 100 },
  { key: "heatingThreshold", unit: "°C", min: 0, max: 200 },
  { key: "surfaceTarget", unit: "°C", min: 0, max: 200 },
  { key: "beginLayerTemperatureTarget", unit: "°C", min: 0, max: 200 },
  { key: "bedPreparationTemperatureTarget", unit: "°C", min: 0, max: 200 },
  { key: "bedPreparationThickness", unit: "µm", min: 0, max: 50000 },
  { key: "printCapTemperatureTarget", unit: "°C", min: 0, max: 200 },
  { key: "printCapThickness", unit: "µm", min: 0, max: 50000 },
  { key: "laserOnPercent", unit: "%", min: 0, max: 100 },
  { key: "totalEnergyDensityPercent", unit: "%", min: 1, max: 500 },
  { key: "laserFirstOutlineEnergyDensity", min: 0, max: 100 },
  { key: "laserOtherOutlineEnergyDensity", min: 0, max: 100 },
  { key: "laserFillEnergyDensity", min: 0, max: 100 },
  { key: "outlineCount", min: 0, max: 20 },
  { key: "coolingTarget", unit: "°C", min: 0, max: 200 },
  { key: "coolingThreshold1", unit: "°C", min: 0, max: 200 },
  { key: "coolingThreshold2", unit: "°C", min: 0, max: 200 },
  { key: "coolingRate1", min: 0, max: 100 },
  { key: "coolingRate2", min: 0, max: 100 },
];

// TimeSpan-string fields, surfaced to the model as SECONDS.
const DELAY_FIELDS = [
  "beginLayerTemperatureDelay",
  "bedPreparationTemperatureDelay",
  "printCapTemperatureDelay",
];

// "5" seconds → "00:00:05"; "00:00:05.000" → 5
function secondsToTimeSpan(n: number): string {
  const h = Math.floor(n / 3600);
  const m = Math.floor((n % 3600) / 60);
  const s = Math.round(n % 60);
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)}`;
}
function timeSpanToSeconds(s: unknown): number | null {
  if (typeof s !== "string") return null;
  const parts = s.split(":");
  if (parts.length !== 3) return null;
  const total = parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
  return isFinite(total) ? total : null;
}

// Strict fields schema: every key enumerated with its bounds in the
// description; null reverts the field to inheriting the Default.
const fieldsShape: Record<string, z.ZodType> = Object.fromEntries([
  ...NUM_FIELDS.map((f) => [
    f.key,
    z.number().min(f.min).max(f.max).nullable().optional()
      .describe(`${f.unit ? `${f.unit}, ` : ""}range [${f.min}..${f.max}]; null = inherit Default`),
  ]),
  ...DELAY_FIELDS.map((k) => [
    k,
    z.number().min(0).max(3600).nullable().optional()
      .describe("seconds, range [0..3600]; null = inherit Default"),
  ]),
  ["material", z.enum(MATERIALS).nullable().optional().describe("null = inherit Default")],
  ["isFillEnabled", z.boolean().nullable().optional().describe("null = inherit Default")],
]);

// fields (tool shape, delays in seconds) → PUT/POST body (TimeSpan strings)
function toBody(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = DELAY_FIELDS.includes(k) && typeof v === "number" ? secondsToTimeSpan(v) : v;
  }
  return out;
}

// Raw profile JSON → surfaced projection (delays back to seconds; the
// ~250 KB stats blob and other internals dropped).
function project(p: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    id: p.id,
    name: p.name,
    createdAt: p.createdAt ?? null,
    material: p.material ?? null,
    isFillEnabled: p.isFillEnabled ?? null,
  };
  for (const f of NUM_FIELDS) out[f.key] = p[f.key] ?? null;
  for (const k of DELAY_FIELDS) out[`${k}Seconds`] = timeSpanToSeconds(p[k]);
  return out;
}

interface ProfileSummary {
  id: string;
  name: string;
  isDefault: boolean;
  createdAt: string | null;
  modifiedAt: string | null;
}

export function registerPrinterProfiles(server: McpServer, client: InovaClient) {
  server.registerTool(
    "profile_list",
    {
      title: "List print profiles",
      description:
        "Live list of print profiles on the printer: id, name, isDefault, " +
        "createdAt, modifiedAt (file mtime — the reliable date). Prefer this " +
        "over the synced inova_profiles reference table, which lags the printer. " +
        "NEVER trust values implied by a profile's name — read fields with " +
        "profile_get.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await client.getBare<ProfileSummary[]>("/profiles"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "profile_get",
    {
      title: "Get a print profile",
      description:
        "One profile's surfaced fields. By default returns the stored DELTA " +
        "(null = inherits the system Default); set merged=true for the " +
        "EFFECTIVE values a print would actually use — adapt from merged " +
        "values, not the sparse delta. Delay fields are surfaced in seconds " +
        "(keys suffixed …Seconds).",
      inputSchema: {
        profile_id: z.string().uuid().describe("Profile id (from profile_list)."),
        merged: z
          .boolean()
          .optional()
          .describe("true → effective values merged over the system Default."),
      },
    },
    async ({ profile_id, merged }) => {
      try {
        const qs = merged ? "?merged=true" : "";
        const p = await client.getBare<Record<string, unknown>>(`/profiles/${profile_id}${qs}`);
        return jsonResult(project(p));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "profile_set",
    {
      title: "Create or update a print profile",
      description:
        "Upsert a print profile. WITHOUT profile_id: creates a new profile — " +
        "name required; optionally base_profile_id to start from a copy of an " +
        "existing profile's stored settings (otherwise every unset field " +
        "inherits the system Default). WITH profile_id: partial update — only " +
        "the passed fields change; null reverts a field to inheriting the " +
        "Default. The system Default profile itself is refused. Creating or " +
        "editing a profile is inert: nothing changes on the printer until the " +
        "operator prints a job that references it. Field bounds are enforced " +
        "here and again by the plugin.",
      inputSchema: {
        profile_id: z
          .string()
          .uuid()
          .optional()
          .describe("Existing profile to update; OMIT to create a new one."),
        base_profile_id: z
          .string()
          .uuid()
          .optional()
          .describe(
            "Create only: copy this profile's stored settings as the starting " +
              "point (ignored on update).",
          ),
        name: z.string().min(1).optional().describe("Required when creating."),
        fields: z
          .object(fieldsShape)
          .strict()
          .optional()
          .describe("Field adjustments (see per-field bounds)."),
      },
    },
    withActionLog(
      server,
      "profile_set",
      async ({ profile_id, base_profile_id, name, fields }) => {
        try {
          const list = await client.getBare<ProfileSummary[]>("/profiles");
          const dflt = list.find((p) => p.isDefault);

          if (profile_id) {
            // update
            if (dflt && profile_id === dflt.id) {
              return errorResult(
                new Error(
                  "the system Default profile is the baseline every other " +
                    "profile inherits from — it is read-only to agents; create " +
                    "a new profile instead",
                ),
              );
            }
            const body = { ...(name !== undefined ? { name } : {}), ...toBody(fields ?? {}) };
            if (Object.keys(body).length === 0) {
              return errorResult(new Error("nothing to change — pass name and/or fields"));
            }
            const updated = await client.putBare<Record<string, unknown>>(
              `/profiles/${profile_id}`,
              body,
            );
            return jsonResult({ action: "updated", profile: project(updated) });
          }

          // create
          if (!name?.trim()) {
            return errorResult(new Error("'name' is required when creating a profile"));
          }
          let base: Record<string, unknown> = {};
          if (base_profile_id) {
            base = await client.getBare<Record<string, unknown>>(`/profiles/${base_profile_id}`);
            // identity/stamp fields must not carry over to the new profile
            delete base.id;
            delete base.name;
            delete base.createdAt;
          }
          const created = await client.postBare<Record<string, unknown>>("/profiles", {
            ...base,
            ...toBody(fields ?? {}),
            name: name.trim(),
          });
          return jsonResult({
            action: "created",
            profile: project(created),
            note:
              "Profile created but not used anywhere yet — attach it to a job " +
              "(e.g. job_create_from_template) and the operator starts the print.",
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );
}
