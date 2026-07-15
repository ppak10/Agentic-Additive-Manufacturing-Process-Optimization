import { AlertOctagon, CheckCircle2, CircleDot, Clock, WifiOff } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricRow } from "@/components/ui/metric-row";
import {
  useRecordingHealth,
  type ClientRecordingState,
  type SpoolStream,
  type SpoolStreamHealth,
} from "@/hooks/useRecordingHealth";
import { PlaybackCard } from "@/panels/PlaybackCard";
import { cn } from "@/lib/utils";

// Same colour language as RecordingStatusBanner so the tab and the header pill
// never disagree. Kept local rather than exported from the banner because the
// banner's map also carries alarm/label fields this page doesn't need.
const STATE_STYLE: Record<ClientRecordingState, { bg: string; label: string; Icon: typeof AlertOctagon }> = {
  RECORDING: { bg: "bg-green-600 text-white", label: "RECORDING", Icon: CheckCircle2 },
  IDLE: { bg: "bg-neutral-500 text-white", label: "IDLE", Icon: CircleDot },
  STARTING_UP: { bg: "bg-yellow-500 text-black", label: "STARTING…", Icon: Clock },
  PRINTING_NOT_RECORDING: { bg: "bg-red-600 text-white animate-pulse", label: "NOT RECORDING", Icon: AlertOctagon },
  PRINTER_UNREACHABLE: { bg: "bg-orange-500 text-white", label: "PRINTER UNREACHABLE", Icon: WifiOff },
  ENDPOINT_UNREACHABLE: { bg: "bg-red-600 text-white animate-pulse", label: "RECORDER OFFLINE", Icon: WifiOff },
};

const STREAMS: SpoolStream[] = ["telemetry", "position", "frames"];

function fmtLag(ms: number | null): string {
  if (ms == null) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}

function fmtAge(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s ago`;
  const m = Math.floor(sec / 60);
  return `${m}m ${sec % 60}s ago`;
}

function StreamRow({
  stream,
  health,
  budgetMs,
  now,
}: {
  stream: SpoolStream;
  health: SpoolStreamHealth | undefined;
  budgetMs: number | null;
  now: number;
}) {
  const append = health?.append_lag_ms ?? null;
  // Only telemetry has a published budget; others are informational. Over budget
  // is the exact condition that used to drive NOT RECORDING, so make it loud.
  const overBudget = budgetMs != null && append != null && append > budgetMs;
  const err = health?.last_error ?? null;
  return (
    <tr className="border-b border-border/30 align-top">
      <td className="py-1 pr-3 font-heading">{stream}</td>
      <td className={cn("py-1 pr-3 font-mono", overBudget && "text-red-600 font-bold")}>{fmtLag(append)}</td>
      <td className="py-1 pr-3 font-mono">{fmtLag(health?.frame_lag_ms ?? null)}</td>
      <td className="py-1 pr-3 font-mono">{health ? health.lines.toLocaleString() : "—"}</td>
      <td className="py-1 pr-3">
        {err ? (
          <span className="text-red-600" title={`${fmtAge(now - err.at_ms)}: ${err.message}`}>
            {err.message.length > 48 ? `${err.message.slice(0, 48)}…` : err.message}
          </span>
        ) : (
          <span className="opacity-40">none</span>
        )}
      </td>
    </tr>
  );
}

export function Recording() {
  const { health, clientState } = useRecordingHealth(2_000);
  const s = STATE_STYLE[clientState];
  const Icon = s.Icon;
  const now = Date.now();

  const firmware = health?.firmware;
  const importer = health?.importer;
  const budgetMs = health?.budgets?.telemetry_max_lag_ms ?? null;
  const staleMs = health ? now - health.timestamp_ms : null;

  return (
    <div className="p-4 flex flex-col gap-4">
      {/* Live status */}
      <Card>
        <CardHeader>
          <CardTitle>Recording status</CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex items-center gap-3 flex-wrap">
            <div
              className={cn(
                "flex items-center gap-2 px-3 py-1 rounded-base border-2 border-border font-heading text-xs shadow-shadow",
                s.bg,
              )}
            >
              <Icon className="size-3.5" />
              <span className="tracking-wide">{s.label}</span>
            </div>
            <span className="text-xs opacity-70">{health?.reason ?? "no health check yet"}</span>
            <span className="ml-auto text-[10px] font-mono opacity-50">
              {staleMs == null ? "—" : `updated ${fmtAge(staleMs)}`}
            </span>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1">
            <MetricRow label="Current build" value={health?.build?.current_build_id ?? "—"} />
            <MetricRow label="Firmware phase" value={firmware?.phase ?? "—"} />
            <MetricRow label="Printing" value={firmware ? (firmware.is_printing ? "yes" : "no") : "—"} />
            <MetricRow
              label="Firmware"
              value={firmware ? (firmware.reachable ? "reachable" : "unreachable") : "—"}
            />
          </div>
        </CardContent>
      </Card>

      {/* Per-stream spool health — the detail the header banner can't show */}
      <Card>
        <CardHeader>
          <CardTitle>Spool streams (NVMe)</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left opacity-70 border-b-2 border-border">
                  <th className="py-1 pr-3">stream</th>
                  <th className="py-1 pr-3">append lag</th>
                  <th className="py-1 pr-3">frame lag</th>
                  <th className="py-1 pr-3">lines</th>
                  <th className="py-1 pr-3">last error</th>
                </tr>
              </thead>
              <tbody>
                {STREAMS.map((stream) => (
                  <StreamRow
                    key={stream}
                    stream={stream}
                    health={health?.spool?.[stream]}
                    budgetMs={stream === "telemetry" ? budgetMs : null}
                    now={now}
                  />
                ))}
              </tbody>
            </table>
          </div>
          {budgetMs != null && (
            <div className="mt-2 text-[10px] opacity-50">
              telemetry append-lag budget: {budgetMs} ms — over budget is the NOT RECORDING trigger
            </div>
          )}
        </CardContent>
      </Card>

      {/* Recorded visual playback (completed builds) */}
      <PlaybackCard />

      {/* Post-print importer */}
      <Card>
        <CardHeader>
          <CardTitle>Importer (spool → Postgres)</CardTitle>
        </CardHeader>
        <CardContent>
          {importer ? (
            <div className="flex items-center gap-3 text-xs">
              <Badge>importing</Badge>
              <span className="font-mono">
                build {importer.buildId} · {importer.stream} · {importer.rowsInserted.toLocaleString()} rows
              </span>
            </div>
          ) : (
            <div className="text-xs opacity-60">Idle — no import running.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
