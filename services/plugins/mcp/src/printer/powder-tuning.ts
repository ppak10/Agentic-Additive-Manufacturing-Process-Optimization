import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { withActionLog } from "../actions.js";
import { errorResult, jsonResult } from "../result.js";
import { attachArtifact, POWDER_TUNING_ARTIFACT_ID } from "./artifacts.js";

// Powder-tuning tools — drive the firmware's interactive powder
// characterisation session through the plugin's /powder-tuning routes. The
// session sinters a gridDim×gridDim grid of test patches (default 5×5), each
// with different laser parameters, to characterise a new powder.
//
// There is deliberately NO start tool: the operator starts the session from
// the firmware wizard (/wizard/powder-tuning on the printer). Every tool
// except status returns a 400 ("no powder tuning session is active") outside
// a session — that human gate is what makes the laser-firing print tool
// acceptable to expose here.
//
// The plugin endpoints have no server-side bounds of their own, so the zod
// ranges below are the enforcement layer; they mirror profile_set's bounds
// (temperatures hard-capped at 200 °C by deliberate choice).
//
// Several commands block until the physical operation completes — the
// per-call timeouts passed to the client are sized for that, not for HTTP.

const SESSION_NOTE =
  "Requires an ACTIVE powder-tuning session (the operator starts one from " +
  "the firmware wizard; there is no start tool). Errors with 400 otherwise.";

// Any successful mutating powder-tuning call pins the live tuning view to the
// conversation's artifact panel (fire-and-forget — a panel write must never
// fail the printer command). No-op outside a conversation.
function pinPanel(result: CallToolResult): CallToolResult {
  if (!result.isError) {
    const raw = process.env.AGENTIC_CONVERSATION_ID;
    const convId = raw ? Number(raw) : NaN;
    if (Number.isFinite(convId) && convId > 0) {
      attachArtifact(convId, "powder_tuning", POWDER_TUNING_ARTIFACT_ID, "created").catch(
        () => {},
      );
    }
  }
  return result;
}

const TIMEOUTS = {
  printSetup: 60_000, // probe dispatch, fast when a session is active
  bedLevel: 300_000, // physical bed stepping
  addLayer: 600_000, // recoater sweep + optional temperature wait
  setSurface: 900_000, // blocks until the IR surface target is reached
  printPatch: 600_000, // laser sinter of one patch
  stop: 600_000, // cap-and-cool handoff
};

export function registerPowderTuning(server: McpServer, client: InovaClient) {
  server.registerTool(
    "powder_tuning_status",
    {
      title: "Get powder-tuning session status",
      description:
        "Read-only: whether a powder-tuning session is active, the printing " +
        "phase, and the session's grid geometry (gridDim, gridMargin, " +
        "powderDepth) plus laser baseline. Also reports the live surface " +
        "heater: surfaceTarget (null = heater off) and surfaceTargetReached — " +
        "poll this after powder_tuning_set_surface to know when the surface " +
        "has actually converged. z1/z2 are the bed positions (z2 drops as " +
        "layers consume the powder budget). Patches are addressed by " +
        "row-major gridIndex 0..gridDim²-1. Cheap to poll; the only " +
        "powder-tuning tool that works without an active session.",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await client.get("/powder-tuning/status"));
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "powder_tuning_print_setup",
    {
      title: "Read effective laser setup (no sinter)",
      description:
        "Read the laser parameters the next patch print would start from " +
        "(profile values plus any session state) WITHOUT firing the laser. " +
        `Call before the first print to know the baseline. ${SESSION_NOTE}`,
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(
          await client.get("/powder-tuning/print/setup", TIMEOUTS.printSetup),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "powder_tuning_bed_level",
    {
      title: "Level the powder bed",
      description:
        "Run the bed-leveling step-and-check sequence. Typically done once " +
        `at the start of a session, before the first layer. Blocks until the ` +
        `sequence completes. ${SESSION_NOTE}`,
      inputSchema: {
        step_thickness: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Step thickness in mm per leveling step. Omit for the firmware default."),
        step_count: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .describe("Number of leveling steps. Omit for the firmware default."),
        dry_print: z
          .boolean()
          .optional()
          .describe("Dry run without dosing powder (default false)."),
      },
    },
    withActionLog(
      server,
      "powder_tuning_bed_level",
      async ({ step_thickness, step_count, dry_print }) => {
        try {
          return pinPanel(jsonResult(
            await client.post(
              "/powder-tuning/bed-level",
              {
                stepThickness: step_thickness,
                stepCount: step_count,
                dryPrint: dry_print,
              },
              TIMEOUTS.bedLevel,
            ),
          ));
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  server.registerTool(
    "powder_tuning_add_layer",
    {
      title: "Spread a fresh powder layer",
      description:
        "Trigger the recoater to spread a fresh layer of powder over the " +
        "bed (do this between patch rounds so each round sinters clean " +
        "powder). With temperature_target set it also waits for that layer " +
        `temperature. Blocks until done. ${SESSION_NOTE}`,
      inputSchema: {
        layer_thickness_um: z
          .number()
          .min(10)
          .max(1000)
          .optional()
          .describe(
            "Layer thickness in MICROMETERS (default 100). Increase when the " +
              "surface is rough or a previous patch stands proud — a too-thin " +
              "layer lets the recoater drag sintered material across the bed.",
          ),
        temperature_target: z
          .number()
          .min(0)
          .max(200)
          .optional()
          .describe("Layer temperature target in °C to reach after spreading. Omit to skip the wait."),
        temperature_delay_seconds: z
          .number()
          .min(0)
          .max(3600)
          .optional()
          .describe("Extra settling delay in seconds after the temperature target is reached."),
        sintered_volume_factor: z
          .number()
          .min(0)
          .max(10)
          .optional()
          .describe("Sintered-volume compensation factor (default 0)."),
      },
    },
    withActionLog(
      server,
      "powder_tuning_add_layer",
      async ({ layer_thickness_um, temperature_target, temperature_delay_seconds, sintered_volume_factor }) => {
        try {
          return pinPanel(jsonResult(
            await client.post(
              "/powder-tuning/layer",
              {
                layerThickness: layer_thickness_um,
                temperatureTarget: temperature_target,
                temperatureDelaySeconds: temperature_delay_seconds,
                sinteredVolumeFactor: sintered_volume_factor,
              },
              TIMEOUTS.addLayer,
            ),
          ));
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  server.registerTool(
    "powder_tuning_set_surface",
    {
      title: "Set surface temperature target",
      description:
        "Set the powder-surface IR temperature target (0 = heater off). May " +
        "return as soon as the target is ACCEPTED, before the surface " +
        "actually reaches it — poll powder_tuning_status until " +
        `surfaceTargetReached is true before sintering. ${SESSION_NOTE}`,
      inputSchema: {
        temperature: z
          .number()
          .min(0)
          .max(200)
          .describe("Surface temperature target in °C (hard cap 200). 0 turns the surface heater OFF."),
      },
    },
    withActionLog(
      server,
      "powder_tuning_set_surface",
      async ({ temperature }) => {
        try {
          return pinPanel(jsonResult(
            await client.post(
              "/powder-tuning/surface",
              { temperature },
              TIMEOUTS.setSurface,
            ),
          ));
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  server.registerTool(
    "powder_tuning_select_patch",
    {
      title: "Select the patch to sinter next",
      description:
        "Select which grid patch the next powder_tuning_print_patch call " +
        "sinters, by row-major grid_index 0..gridDim²-1 (gridDim from " +
        "powder_tuning_status; 5×5 grid → 0..24). Selecting does not fire " +
        `the laser. Send {} to read back the current selection. ${SESSION_NOTE}`,
      inputSchema: {
        grid_index: z
          .number()
          .int()
          .min(0)
          .max(99)
          .optional()
          .describe("Row-major patch index, 0..gridDim²-1. Omit to leave unchanged."),
        fill_phase: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Fill hatch phase index. Omit to leave unchanged."),
        print_label_index: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Number printed as the patch label. Omit to use the patch index."),
      },
    },
    withActionLog(
      server,
      "powder_tuning_select_patch",
      async ({ grid_index, fill_phase, print_label_index }) => {
        try {
          return pinPanel(jsonResult(
            await client.post("/powder-tuning/params", {
              gridIndex: grid_index,
              fillPhase: fill_phase,
              printLabelIndex: print_label_index,
            }),
          ));
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  server.registerTool(
    "powder_tuning_print_patch",
    {
      title: "Sinter the selected patch",
      description:
        "FIRES THE LASER: sinter the currently selected patch with the given " +
        "parameters. Omitted fields fall back to the session profile's " +
        "values (read them with powder_tuning_print_setup). Select a patch " +
        "with powder_tuning_select_patch first, and record which parameters " +
        "went to which patch — the response returns the setup actually " +
        `used. Blocks until the sinter completes. ${SESSION_NOTE}`,
      inputSchema: {
        laser_on_percent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Laser power in % (0–100)."),
        total_energy_density_percent: z
          .number()
          .min(1)
          .max(500)
          .optional()
          .describe("Total energy density scaling in % (1–500)."),
        laser_fill_energy_density: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Fill energy density (0–100)."),
        laser_first_outline_energy_density: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("First-outline energy density (0–100)."),
        laser_other_outline_energy_density: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Other-outline energy density (0–100)."),
        laser_fill_speed_xy: z
          .number()
          .min(1)
          .max(2000)
          .optional()
          .describe("Fill scan speed in mm/s (1–2000)."),
        laser_outline_speed_xy: z
          .number()
          .min(1)
          .max(2000)
          .optional()
          .describe("Outline scan speed in mm/s (1–2000)."),
        outline_count: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe("Number of outline passes (0–20)."),
        fill_phase: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Fill hatch phase index."),
        hotspot_overlap_percent: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe(
            "Hotspot overlap in % (0–100) for THIS patch only — no need to " +
              "edit the profile mid-session. Echoed in the response; verify " +
              "it there (older plugin builds ignore it silently).",
          ),
        outline_power_increase: z
          .number()
          .min(0)
          .max(100)
          .optional()
          .describe("Outline power increase (0–100) for this patch. Echoed in the response."),
        fill_outline_skip_count: z
          .number()
          .int()
          .min(0)
          .max(20)
          .optional()
          .describe("Number of outlines the fill hatch skips (0–20) for this patch. Echoed in the response."),
        print_number_enabled: z
          .boolean()
          .optional()
          .describe("Sinter the patch's number label next to it (default true)."),
      },
    },
    withActionLog(
      server,
      "powder_tuning_print_patch",
      async (args) => {
        try {
          return pinPanel(jsonResult(
            await client.post(
              "/powder-tuning/print",
              {
                laserOnPercent: args.laser_on_percent,
                totalEnergyDensityPercent: args.total_energy_density_percent,
                laserFillEnergyDensity: args.laser_fill_energy_density,
                laserFirstOutlineEnergyDensity: args.laser_first_outline_energy_density,
                laserOtherOutlineEnergyDensity: args.laser_other_outline_energy_density,
                laserFillSpeedXY: args.laser_fill_speed_xy,
                laserOutlineSpeedXY: args.laser_outline_speed_xy,
                outlineCount: args.outline_count,
                fillPhase: args.fill_phase,
                hotspotOverlapPercent: args.hotspot_overlap_percent,
                outlinePowerIncrease: args.outline_power_increase,
                fillOutlineSkipCount: args.fill_outline_skip_count,
                printNumberEnabled: args.print_number_enabled,
              },
              TIMEOUTS.printPatch,
            ),
          ));
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );

  server.registerTool(
    "powder_tuning_stop",
    {
      title: "End the powder-tuning session",
      description:
        "End the session cleanly — cap-and-cool by default, cool_now to skip " +
        "the powder cap. Only do this when the operator asks for it or the " +
        "agreed patch plan is complete; there is no tool to restart the " +
        `session. ${SESSION_NOTE}`,
      inputSchema: {
        cool_now: z
          .boolean()
          .optional()
          .describe("Skip the powder cap and start cooling immediately (default false = cap-and-cool)."),
      },
    },
    withActionLog(server, "powder_tuning_stop", async ({ cool_now }) => {
      try {
        return pinPanel(jsonResult(
          await client.post("/powder-tuning/stop", { coolNow: cool_now }, TIMEOUTS.stop),
        ));
      } catch (err) {
        return errorResult(err);
      }
    }),
  );
}
