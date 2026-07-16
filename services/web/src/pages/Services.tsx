import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  AlertOctagon,
  Bot,
  CheckCircle2,
  Cpu,
  Database,
  HelpCircle,
  Radio,
  RefreshCw,
  WifiOff,
} from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricRow } from "@/components/ui/metric-row";
import { useServicesHealth, type ServiceProbe } from "@/hooks/useServicesHealth";
import { formatUptime } from "@/hooks/usePluginInfo";
import { cn } from "@/lib/utils";

// Expected identity of the real database. If the connected cluster is missing
// the agent tables or has fewer builds than this, we are almost certainly
// looking at a stale or freshly-initdb'd datadir (the 2026-07-09 docker/mount
// boot race) — make that loud. Bump MIN_BUILDS as history grows; it only
// guards against connecting to the WRONG cluster, not against new builds.
const MIN_BUILDS = 46;

type Tone = "up" | "down" | "warn" | "unknown";

const TONE_STYLE: Record<Tone, { bg: string; label: string; Icon: typeof CheckCircle2 }> = {
  up: { bg: "bg-green-600 text-white", label: "UP", Icon: CheckCircle2 },
  warn: { bg: "bg-yellow-500 text-black", label: "DEGRADED", Icon: AlertOctagon },
  down: { bg: "bg-red-600 text-white animate-pulse", label: "DOWN", Icon: WifiOff },
  unknown: { bg: "bg-neutral-500 text-white", label: "UNKNOWN", Icon: HelpCircle },
};

function ServiceCard({
  title,
  subtitle,
  icon: Icon,
  tone,
  toneLabel,
  error,
  children,
}: {
  title: string;
  subtitle: string;
  icon: typeof Cpu;
  tone: Tone;
  toneLabel?: string;
  error?: string | null;
  children?: ReactNode;
}) {
  const s = TONE_STYLE[tone];
  const StatusIcon = s.Icon;
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Icon className="size-4" />
          <span>{title}</span>
          <span className="font-mono text-[10px] opacity-50">{subtitle}</span>
          <Badge className={cn("ml-auto gap-1", s.bg)}>
            <StatusIcon className="size-3" />
            {toneLabel ?? s.label}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-1">
        {error && tone !== "up" ? (
          <p className="text-xs text-red-600 break-all">{error}</p>
        ) : null}
        {children}
      </CardContent>
    </Card>
  );
}

function fmtAgo(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  const min = Math.round(ms / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h}h ${min % 60}m ago`;
  return `${Math.floor(h / 24)}d ago`;
}

function probeTone(p: ServiceProbe<unknown>): Tone {
  return p.status === "up" ? "up" : p.status === "down" ? "down" : "unknown";
}

interface HarnessStatus {
  harness: string;
  installed: boolean;
  version: string | null;
  lastSession: { started_at: string; exit_code: number | null; model: string | null } | null;
  loginHint: string;
}

// Auth panel v1: status probe + guided login commands. v2 (designed, not
// built): pty relay that captures each CLI's paste-URL OAuth flow into the
// GUI and stores credentials in a broker-home volume.
function HarnessAuthCard() {
  const [rows, setRows] = useState<HarnessStatus[] | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async () => {
    setBusy(true);
    try {
      const r = await fetch("/agent/harness/status");
      if (r.ok) setRows(await r.json());
    } catch { /* broker down — the broker card above says so */ }
    setBusy(false);
  }, []);
  useEffect(() => { void load(); }, [load]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bot className="size-4" />
          <span>Harness auth</span>
          <span className="font-mono text-[10px] opacity-50">pinned in broker image</span>
          <button
            onClick={() => void load()}
            className="ml-auto text-xs underline opacity-70 hover:opacity-100 flex items-center gap-1"
            disabled={busy}
          >
            <RefreshCw className={cn("size-3", busy && "animate-spin")} /> recheck
          </button>
        </CardTitle>
      </CardHeader>
      <CardContent>
        {!rows ? (
          <p className="text-xs opacity-60">probing…</p>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-left opacity-60">
              <tr><th className="py-1">harness</th><th>version</th><th>last session</th><th>login (docker exec)</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const ok = r.lastSession?.exit_code === 0;
                return (
                  <tr key={r.harness} className="border-t border-border/30 align-top">
                    <td className="py-1 pr-2 font-heading">{r.harness}</td>
                    <td className="pr-2 font-mono">{r.installed ? r.version : <span className="text-red-600 font-bold">NOT INSTALLED</span>}</td>
                    <td className="pr-2">
                      {r.lastSession ? (
                        <span className={cn(ok ? "text-green-700" : "text-red-600")}>
                          {ok ? "ok" : `exit ${r.lastSession.exit_code}`} · {new Date(r.lastSession.started_at).toLocaleString()}
                          {r.lastSession.model ? ` · ${r.lastSession.model}` : ""}
                        </span>
                      ) : (
                        <span className="opacity-40">never ran</span>
                      )}
                    </td>
                    <td className="font-mono text-[10px] opacity-70 break-all">{r.loginHint}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}

export function Services() {
  const health = useServicesHealth(4_000);

  if (!health) {
    return <div className="p-4 text-sm opacity-60">Probing services…</div>;
  }

  const { recorder, db, broker, plugin } = health;
  const rec = recorder.data;
  const dbd = db.data;
  const brk = broker.data;
  const plg = plugin.data;

  // Stale-cluster tripwire (see comment on MIN_BUILDS).
  const dbIdentityBad =
    db.status === "up" &&
    dbd != null &&
    (dbd.has_agent_tables === false ||
      dbd.has_build_summaries === false ||
      (dbd.builds_count != null && dbd.builds_count < MIN_BUILDS));
  const dbTone: Tone = db.status !== "up" ? probeTone(db) : dbIdentityBad ? "warn" : "up";

  const firmwareTone: Tone =
    recorder.status !== "up" ? "unknown" : rec?.firmware.reachable ? "up" : "down";

  return (
    <div className="p-4 space-y-4">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        <ServiceCard
          title="Recorder"
          subtitle="agentic-recorder · :3000"
          icon={Radio}
          tone={probeTone(recorder)}
          toneLabel={recorder.status === "up" ? rec?.overall : undefined}
          error={recorder.error}
        >
          {rec && (
            <>
              <p className="text-xs opacity-70">{rec.reason}</p>
              <MetricRow label="current build" value={rec.build.current_build_id ?? "none"} />
              <MetricRow
                label="telemetry frame lag"
                value={rec.spool.telemetry.frame_lag_ms != null ? `${rec.spool.telemetry.frame_lag_ms} ms` : "—"}
              />
              {rec.importer && (
                <MetricRow
                  label="importer"
                  value={`build ${rec.importer.buildId} ${rec.importer.stream} (${rec.importer.rowsInserted.toLocaleString()} rows)`}
                />
              )}
              <MetricRow label="probe latency" value={`${recorder.latencyMs} ms`} />
            </>
          )}
          {recorder.status === "down" && (
            <p className="text-xs opacity-70">
              systemctl --user status agentic-recorder · journalctl --user -u agentic-recorder -f
            </p>
          )}
        </ServiceCard>

        <ServiceCard
          title="Postgres"
          subtitle="agentic-sls-postgres · :5432"
          icon={Database}
          tone={dbTone}
          toneLabel={dbIdentityBad ? "WRONG CLUSTER?" : undefined}
          error={db.error ?? dbd?.error}
        >
          {dbd?.connected && (
            <>
              {dbIdentityBad && (
                <p className="text-xs text-red-600 font-bold">
                  Connected cluster fails the identity check (builds {dbd.builds_count ?? "?"} /{" "}
                  {MIN_BUILDS} expected
                  {dbd.has_agent_tables === false ? ", agent tables missing" : ""}
                  {dbd.has_build_summaries === false ? ", build_summaries missing" : ""}
                  ) — possible stale datadir from a docker/mount boot race. See wiki Operations.
                </p>
              )}
              <MetricRow label="builds" value={`${dbd.builds_count ?? "—"} (max id ${dbd.max_build ?? "—"})`} />
              <MetricRow label="agent tables" value={dbd.has_agent_tables ? "present" : "MISSING"} />
              <MetricRow label="build summaries" value={dbd.has_build_summaries ? "present" : "MISSING"} />
              <MetricRow label="last event" value={fmtAgo(dbd.last_event_ts)} />
              <MetricRow label="query latency" value={`${dbd.latency_ms} ms`} />
            </>
          )}
          {db.status === "unknown" && (
            <p className="text-xs opacity-70">Reported via the recorder — recorder is down, so Postgres state is unknown.</p>
          )}
        </ServiceCard>

        <ServiceCard
          title="Agent broker"
          subtitle="agentic-broker · :3100"
          icon={Bot}
          tone={probeTone(broker)}
          error={broker.error}
        >
          {brk && (
            <>
              <MetricRow label="active chats" value={brk.chats} />
              <MetricRow label="database" value={brk.db ? "connected" : "NOT CONFIGURED"} />
              <MetricRow label="probe latency" value={`${broker.latencyMs} ms`} />
            </>
          )}
          {broker.status === "down" && (
            <p className="text-xs opacity-70">systemctl --user status agentic-broker</p>
          )}
        </ServiceCard>

        <ServiceCard
          title="Inova plugin"
          subtitle="printer · :5001"
          icon={Cpu}
          tone={probeTone(plugin)}
          error={plugin.error}
        >
          {plg && (
            <>
              <MetricRow label="version" value={plg.version} />
              <MetricRow label="uptime" value={formatUptime(plg.uptimeSeconds)} />
              <MetricRow label="probe latency" value={`${plugin.latencyMs} ms`} />
            </>
          )}
          {plugin.status === "unknown" && (
            <p className="text-xs opacity-70">Proxied via the recorder — recorder is down, so plugin state is unknown.</p>
          )}
        </ServiceCard>

        <ServiceCard
          title="Firmware"
          subtitle="printer · :80"
          icon={Cpu}
          tone={firmwareTone}
          error={rec?.firmware.error ?? null}
        >
          {rec && (
            <>
              <MetricRow label="reachable" value={rec.firmware.reachable ? "yes" : "no"} />
              <MetricRow label="phase" value={rec.firmware.phase ?? "idle"} />
              <MetricRow label="printing" value={rec.firmware.is_printing ? "yes" : "no"} />
            </>
          )}
          {firmwareTone === "unknown" && (
            <p className="text-xs opacity-70">Reported via the recorder — recorder is down, so firmware state is unknown.</p>
          )}
        </ServiceCard>
      </div>
      <HarnessAuthCard />
      <p className="text-[10px] font-mono opacity-40">
        probed {new Date(health.checkedAt).toLocaleTimeString()} · every 4s · dashboard (agentic-web · :5173) is up if
        you can read this
      </p>
    </div>
  );
}
