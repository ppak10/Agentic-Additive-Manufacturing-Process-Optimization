import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ExternalLink } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

// Datasets section: one page per HuggingFace dataset repo (submodules under
// datasets/). Purpose: a curation/health surface for improving each dataset
// — what's in it, where it lives, what flows into it — starting with
// telemetry. Stats come from /api/datasets/summary (recorder; big tables
// are pg_class ESTIMATES — exact counts over 100M-row telemetry wedge).

interface DatasetSpec {
  slug: string;
  title: string;
  hf: string; // huggingface repo id
  submodule: string;
  description: string;
  flows: string[]; // what writes into it
  statsKey: "telemetry" | "database" | "astm" | "conversations" | null;
  statLabels: Record<string, string>;
}

export const DATASETS: DatasetSpec[] = [
  {
    slug: "telemetry",
    title: "Telemetry",
    hf: "ppak10/Agentic-SLS-Telemetry",
    submodule: "datasets/Agentic-SLS-Telemetry",
    description:
      "Per-build print telemetry: 10 Hz sensor ticks with embedded chamber/galvo/thermal frames, " +
      "high-frequency position bursts, camera frame chunks (store-mode zips), raw NDJSON spool " +
      "archives, and the events stream (build lifecycle, defect verdicts, operator feedback, " +
      "layer objects with camera-space bboxes).",
    flows: [
      "recorder → NVMe spool → Postgres → sls-export (ticks parquet into source/)",
      "sls-deliver-frames (chunked frame zips), sls-deliver-spool (raw NDJSON archives)",
      "events: defect_detection / defect_feedback / operator_action / build_layout / layer_objects",
    ],
    statsKey: "telemetry",
    statLabels: {
      builds: "builds",
      ticks_est: "telemetry ticks (est)",
      frames_est: "frames (est)",
      position_est: "position rows (est)",
      events: "events",
    },
  },
  {
    slug: "database",
    title: "Database",
    hf: "ppak10/Agentic-SLS-Database",
    submodule: "datasets/Agentic-SLS-Database",
    description:
      "Firmware-side ground truth: PrintSession archives from the printer, job and print-profile " +
      "definitions, and the hand-reviewed build↔session linkage CSV. Reference tables in Postgres " +
      "are synced COPIES — fix data here and re-run sls-sync-reference.",
    flows: [
      "rsync from inova:/home/ppak/SLS4All/PrintSessions after new sessions",
      "source/build_to_inova_session.csv — hand-reviewed linkage (sls-match-build-sessions proposes)",
      "sls-sync-reference → inova_jobs / inova_print_profiles / inova_print_sessions",
    ],
    statsKey: "database",
    statLabels: { jobs: "jobs", profiles: "print profiles", print_sessions: "print sessions" },
  },
  {
    slug: "astm",
    title: "ASTM",
    hf: "ppak10/Agentic-SLS-ASTM",
    submodule: "datasets/Agentic-SLS-ASTM",
    description:
      "Mechanical-outcome ground truth: ASTM D638 tensile and D790 flexural specimen measurements " +
      "linking printed parts back to their builds and process parameters — the outcome variable " +
      "of the whole optimization loop.",
    flows: [
      "manual specimen measurement entry in the dataset repo",
      "sls-sync-reference → astm_specimens (queryable via the astm_query MCP tool)",
    ],
    statsKey: "astm",
    statLabels: { specimens: "specimens" },
  },
  {
    slug: "conversations",
    title: "Conversations",
    hf: "ppak10/Agentic-SLS-Conversations",
    submodule: "datasets/Agentic-SLS-Conversations",
    description:
      "The agent plane's record: normalized conversations and per-turn session stats for every " +
      "harness run, chat, and panel turn — including blinded panel candidates, selection labels " +
      "(chosen / none / user-authored), and conversation↔build span links. Raw CLI transcripts " +
      "live in source/sessions/.",
    flows: [
      "broker chats + panel turns → agent_conversations/_messages/_sessions/_selections",
      "raw transcripts written directly into source/sessions/ (commit often)",
      "sls-export-conversations → data/ parquet",
    ],
    statsKey: "conversations",
    statLabels: {
      conversations: "conversations",
      sessions: "sessions",
      messages_est: "messages (est)",
      selections: "panel selections",
      conversation_builds: "build links",
    },
  },
  {
    slug: "knowledge",
    title: "Knowledge",
    hf: "ppak10/Agentic-SLS-Knowledge",
    submodule: "datasets/SLS-Knowledge",
    description:
      "Curated reference corpus served to agents at runtime by the reference_* MCP tools: powder " +
      "TDS/SDS sheets, SLS process fundamentals, defect taxonomy, Fuse→Inova parameter translation, " +
      "and (eventually) knowledge the agentic system writes down itself. The submodule pin records " +
      "which corpus version agents saw.",
    flows: [
      "human-curated source/ docs (drafts/ pending review before promotion)",
      "served live by reference_list / reference_get MCP tools",
    ],
    statsKey: null,
    statLabels: {},
  },
];

type SummaryMap = Record<string, Record<string, number>>;

function StatTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="border-2 border-border rounded-base shadow-shadow bg-background px-3 py-2">
      <div className="text-lg font-heading">{value.toLocaleString()}</div>
      <div className="text-[10px] font-mono opacity-60">{label}</div>
    </div>
  );
}

interface BuildRow {
  id: string;
  job_name: string | null;
  started_at: string;
  ended_at: string | null;
  notes: string | null;
}

function TelemetryBuilds() {
  const [builds, setBuilds] = useState<BuildRow[] | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/builds")
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setBuilds(d);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);
  if (!builds) return <div className="text-xs opacity-60">Loading builds…</div>;
  return (
    <div className="max-h-96 overflow-y-auto border-2 border-border rounded-base">
      <table className="w-full text-xs font-mono">
        <thead className="sticky top-0 bg-secondary-background">
          <tr className="text-left border-b-2 border-border">
            <th className="px-2 py-1">#</th>
            <th className="px-2 py-1">job</th>
            <th className="px-2 py-1">started</th>
            <th className="px-2 py-1">ended</th>
          </tr>
        </thead>
        <tbody>
          {builds.map((b) => (
            <tr key={b.id} className="border-b border-border/40 hover:bg-secondary-background">
              <td className="px-2 py-1 flex gap-2">
                <Link to={`/datasets/telemetry/${b.id}`} className="underline font-heading">
                  {b.id} lab
                </Link>
                <Link to={`/builds/${b.id}`} className="underline opacity-60">
                  build
                </Link>
              </td>
              <td className="px-2 py-1 truncate max-w-[24rem]">{b.job_name ?? "—"}</td>
              <td className="px-2 py-1">{new Date(b.started_at).toLocaleString()}</td>
              <td className="px-2 py-1">
                {b.ended_at ? new Date(b.ended_at).toLocaleString() : <Badge>active</Badge>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function DatasetPage() {
  const { slug } = useParams();
  const spec = DATASETS.find((d) => d.slug === slug);
  const [summary, setSummary] = useState<SummaryMap | null>(null);
  const [summaryErr, setSummaryErr] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/datasets/summary")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
      .then((d) => {
        if (!cancelled) setSummary(d);
      })
      .catch(() => {
        if (!cancelled) setSummaryErr(true);
      });
    return () => {
      cancelled = true;
    };
  }, [slug]);

  if (!spec) return <div className="p-4 text-xs opacity-60">Unknown dataset.</div>;
  const stats = spec.statsKey && summary ? summary[spec.statsKey] : null;

  return (
    <div className="p-4 flex flex-col gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span>{spec.title}</span>
            <a
              href={`https://huggingface.co/datasets/${spec.hf}`}
              target="_blank"
              rel="noreferrer"
            >
              <Badge className="gap-1">
                {spec.hf} <ExternalLink className="size-3" />
              </Badge>
            </a>
            <span className="ml-auto text-[10px] font-mono opacity-50">{spec.submodule}</span>
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4">
          <p className="text-xs leading-relaxed">{spec.description}</p>
          {spec.statsKey && (
            <>
              {stats ? (
                <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
                  {Object.entries(spec.statLabels).map(([key, label]) => (
                    <StatTile key={key} label={label} value={stats[key] ?? 0} />
                  ))}
                </div>
              ) : summaryErr ? (
                <Alert className="bg-secondary-background text-foreground">
                  <AlertTitle className="text-xs">Stats pending</AlertTitle>
                  <AlertDescription className="text-xs opacity-70">
                    /api/datasets/summary isn't live yet — it deploys with the queued
                    post-print recorder restart.
                  </AlertDescription>
                </Alert>
              ) : (
                <div className="text-xs opacity-60">Loading stats…</div>
              )}
            </>
          )}
          <div>
            <div className="text-[10px] uppercase tracking-wider opacity-50 mb-1">data flows</div>
            <ul className="text-xs font-mono grid gap-1">
              {spec.flows.map((f) => (
                <li key={f} className="border-l-2 border-border pl-2">
                  {f}
                </li>
              ))}
            </ul>
          </div>
        </CardContent>
      </Card>

      {spec.slug === "telemetry" && (
        <Card>
          <CardHeader>
            <CardTitle>Builds</CardTitle>
          </CardHeader>
          <CardContent>
            <TelemetryBuilds />
          </CardContent>
        </Card>
      )}
    </div>
  );
}
