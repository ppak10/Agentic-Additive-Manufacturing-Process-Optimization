import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { InovaClient } from "../client.js";
import { withActionLog } from "../actions.js";
import { attachArtifact, debugName } from "./artifacts.js";
import { errorResult, jsonResult } from "../result.js";

// Auto-pin a just-created job to the conversation's artifact panel so the
// operator sees the agent's output without a second tool call. Best-effort:
// the panel is a convenience, never a reason to fail the job creation.
function conversationId(): number | null {
  const n = Number(process.env.AGENTIC_CONVERSATION_ID);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// Stored-job tools — the printer's .s4a job files (name, print profile,
// nesting instances). Distinct from builds_list/build_get, which read the
// recorder's history of what was PRINTED; these read/write what is QUEUED.
//
// Template convention: a job whose name contains "[TEMPLATE]" is an
// operator-blessed test layout. Agents may INSTANTIATE templates
// (job_create_from_template) but never modify them or bless new ones —
// job_set refuses both. Curation happens in the GUI only.
//
// Creating or editing a job is inert: nothing prints until the operator
// starts the job from the firmware UI. Both mutating tools log to
// agent_actions via withActionLog.

const TEMPLATE_MARK = "[TEMPLATE]";

interface JobSummary {
  id: string;
  type: string;
  name: string;
  createdAt: string | null;
}

interface JobDetail extends JobSummary {
  printProfileId: string | null;
  objectFiles: { id: string; name: string; hash: string }[];
}

interface ProfileSummary {
  id: string;
  name: string;
  isDefault: boolean;
}

const isTemplate = (name: string | null | undefined) =>
  (name ?? "").includes(TEMPLATE_MARK);

export function registerPrinterJobs(server: McpServer, client: InovaClient) {
  server.registerTool(
    "job_list",
    {
      title: "List stored jobs",
      description:
        "List the print jobs stored on the printer (id, name, type, createdAt, " +
        "is_template). Jobs whose name contains \"[TEMPLATE]\" are operator-blessed " +
        "test layouts — the only jobs job_create_from_template accepts as a source. " +
        "Available while idle; unrelated to builds_list (recorded print history).",
      inputSchema: {},
    },
    async () => {
      try {
        const jobs = await client.getBare<JobSummary[]>("/jobs");
        return jsonResult(
          jobs.map((j) => ({ ...j, is_template: isTemplate(j.name) })),
        );
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "job_get",
    {
      title: "Get a stored job",
      description:
        "Full detail for one stored job: metadata (name, print profile id, object " +
        "files) plus the persisted nesting instances (part names, transforms, " +
        "chamber dims — mesh metadata only, no geometry bytes). Works while idle, " +
        "unlike the live /printing surface.",
      inputSchema: {
        job_id: z.string().uuid().describe("Stored job id (from job_list)."),
      },
    },
    async ({ job_id }) => {
      try {
        const detail = await client.getBare<JobDetail>(`/jobs/${job_id}`);
        const nesting = await client.getBare<{
          chamber: unknown;
          instances: unknown[];
        }>(`/jobs/${job_id}/instances`);
        return jsonResult({
          ...detail,
          is_template: isTemplate(detail.name),
          chamber: nesting.chamber,
          instances: nesting.instances,
        });
      } catch (err) {
        return errorResult(err);
      }
    },
  );

  server.registerTool(
    "job_set",
    {
      title: "Rename a job / change its print profile",
      description:
        "Update a stored job's name and/or print profile reference. Metadata-only " +
        "and inert (nothing prints until the operator starts the job). Refuses to " +
        "touch \"[TEMPLATE]\" jobs and refuses names that would create one — " +
        "template curation is operator-only, via the GUI.",
      inputSchema: {
        job_id: z.string().uuid().describe("Stored job id (from job_list)."),
        name: z.string().min(1).optional().describe("New job name."),
        print_profile_id: z
          .string()
          .optional()
          .describe(
            "Print profile id to attach (from the /profiles list or the " +
              "inova_profiles reference table). Empty string clears the reference.",
          ),
      },
    },
    withActionLog(server, "job_set", async ({ job_id, name, print_profile_id }) => {
      try {
        if (name === undefined && print_profile_id === undefined) {
          return errorResult(
            new Error("provide at least one of 'name' or 'print_profile_id'"),
          );
        }
        if (isTemplate(name)) {
          return errorResult(
            new Error(
              `names containing "${TEMPLATE_MARK}" are reserved — templates are ` +
                "blessed by the operator in the GUI, not by agents",
            ),
          );
        }
        const current = await client.getBare<JobDetail>(`/jobs/${job_id}`);
        if (isTemplate(current.name)) {
          return errorResult(
            new Error(
              `job "${current.name}" is a template — templates are read-only to ` +
                "agents (use job_create_from_template to instantiate it instead)",
            ),
          );
        }
        const updated = await client.patchBare<JobDetail>(`/jobs/${job_id}`, {
          ...(name !== undefined ? { name } : {}),
          ...(print_profile_id !== undefined
            ? { printProfileId: print_profile_id }
            : {}),
        });
        return jsonResult(updated);
      } catch (err) {
        return errorResult(err);
      }
    }),
  );

  server.registerTool(
    "job_create_from_template",
    {
      title: "Create a job from a template",
      description:
        "Clone an operator-blessed \"[TEMPLATE]\" job into a new job with a " +
        "different print profile — the standard way to prepare a profile " +
        "experiment on a known test layout. The clone is inert: it appears in " +
        "the GUI's Jobs page for the operator to review and start. Refuses " +
        "non-template sources. Default name: template name (marker stripped) + " +
        "profile name + date.",
      inputSchema: {
        template_job_id: z
          .string()
          .uuid()
          .describe("Source job id — its name must contain \"[TEMPLATE]\"."),
        print_profile_id: z
          .string()
          .uuid()
          .describe("Print profile id for the new job (validated live)."),
        name: z
          .string()
          .min(1)
          .optional()
          .describe("Name for the new job (may not contain \"[TEMPLATE]\")."),
      },
    },
    withActionLog(
      server,
      "job_create_from_template",
      async ({ template_job_id, print_profile_id, name }) => {
        try {
          if (isTemplate(name)) {
            return errorResult(
              new Error(
                `clone names may not contain "${TEMPLATE_MARK}" — templates are ` +
                  "blessed by the operator, not by agents",
              ),
            );
          }
          const src = await client.getBare<JobDetail>(`/jobs/${template_job_id}`);
          if (!isTemplate(src.name)) {
            return errorResult(
              new Error(
                `job "${src.name}" is not a template (name lacks ` +
                  `"${TEMPLATE_MARK}") — agents may only create jobs from ` +
                  "operator-blessed templates; ask the operator to bless it first",
              ),
            );
          }
          const profiles = await client.getBare<ProfileSummary[]>("/profiles");
          const profile = profiles.find((p) => p.id === print_profile_id);
          if (!profile) {
            return errorResult(
              new Error(
                `no print profile with id ${print_profile_id} — known: ` +
                  profiles.map((p) => `${p.id} (${p.name})`).join(", "),
              ),
            );
          }
          // "/" in a name (common in profile names like "32mJ/mm") is
          // sanitized to "_" in the stored filename by the firmware — keep
          // names filesystem-literal so what you ask for is what persists.
          // Debug conversations get a "[DEBUG] " prefix (server-enforced)
          // so test content is findable and deletable later.
          const cloneName = await debugName(
            (
              name ??
              `${src.name.replaceAll(TEMPLATE_MARK, "").trim()} - ${profile.name} ` +
                `(${new Date().toISOString().slice(0, 10)})`
            ).replace(/[/\\]/g, "-"),
          );
          const clone = await client.postBare<JobDetail>(
            `/jobs/${template_job_id}/clone`,
            { name: cloneName, printProfileId: print_profile_id },
          );
          // Pin the new job to the conversation panel (provenance='created').
          const convId = conversationId();
          if (convId != null && clone.id) {
            await attachArtifact(convId, "job", clone.id, "created").catch((err) =>
              console.error("artifact auto-attach failed:", err?.message),
            );
          }
          return jsonResult({
            ...clone,
            note:
              "Job created but NOT started — the operator reviews and starts it " +
              "from the printer UI / GUI Jobs page.",
          });
        } catch (err) {
          return errorResult(err);
        }
      },
    ),
  );
}
