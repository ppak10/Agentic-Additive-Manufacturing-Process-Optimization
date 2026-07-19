import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { withActionLog } from "../actions.js";
import { errorResult, jsonResult } from "../result.js";

// Per-print object exclusion — the live "skip this part" control, the MCP
// mirror of the Mission Control chamber click-to-exclude flow (the same
// firmware POST /printing/objects/{id}/exclude). Object ids are the firmware's
// CodePlotterMarkedObject.Id, stable for the duration of a print. Excluding
// tells the firmware to stop laser-scanning that object on SUBSEQUENT layers;
// layers already sintered are not undone. Only effective during the active
// print — other phases are a no-op (firmware returns the unchanged state).

interface PrintingObject {
  id: number;
  name: string;
  hash: string | null;
  transform: number[][];
  bounds: { center: [number, number, number]; size: [number, number, number] } | null;
  isExcluded: boolean;
}

export function registerPrintingObjects(server: McpServer, client: InovaClient) {
  server.registerTool(
    "printing_objects_list",
    {
      title: "List parts in the active print",
      description:
        "List the objects in the CURRENT print with their exclusion state: id, " +
        "name, mesh hash, whether excluded, and the mesh-local bounds. The id is " +
        "the firmware object id passed to printing_object_exclude. Empty while the " +
        "printer is idle (no active print). The raw 4x4 transform is projected " +
        "away to keep the payload small.",
      inputSchema: {},
    },
    async () => {
      try {
        const res = await client.get<{ objects?: PrintingObject[] }>("/printing/objects");
        const objects = (res.data?.objects ?? []).map((o) => ({
          id: o.id,
          name: o.name,
          hash: o.hash,
          isExcluded: o.isExcluded,
          bounds: o.bounds,
        }));
        return jsonResult({ respondedAt: res.respondedAt, objects });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "printing_object_exclude",
    {
      title: "Exclude / re-include a part in the active print",
      description:
        "Exclude a part from the LIVE print (stop laser-scanning it on subsequent " +
        "layers) or re-include a previously excluded one. Same effect as clicking " +
        "a part in Mission Control and confirming: it takes effect on the NEXT " +
        "layer and does NOT undo layers already sintered. Get object ids from " +
        "printing_objects_list. Only effective during the active print; other " +
        "phases return the unchanged state. Returns the firmware-confirmed " +
        "{id, isExcluded}.",
      inputSchema: {
        object_id: z
          .number()
          .int()
          .describe("Firmware object id (from printing_objects_list)."),
        excluded: z
          .boolean()
          .describe("true = exclude the part; false = re-include it."),
      },
    },
    withActionLog(server, "printing_object_exclude", async ({ object_id, excluded }) => {
      try {
        return jsonResult(
          await client.post(`/printing/objects/${object_id}/exclude`, { excluded }),
        );
      } catch (err) {
        return errorResult(err);
      }
    }),
  );
}
