import { useState } from "react";
import { AlertOctagon, CheckCircle2, CircleDot, Clock, WifiOff, Bell } from "lucide-react";
import {
  useRecordingHealth,
  requestNotificationPermission,
  type ClientRecordingState,
} from "@/hooks/useRecordingHealth";
import { cn } from "@/lib/utils";

// Colors chosen so the two "you should act" states (PRINTING_NOT_RECORDING and
// ENDPOINT_UNREACHABLE) are unmistakably red and animate. IDLE is neutral —
// idle is fine, not a warning. RECORDING is green. STARTING_UP is warm.
const STYLES: Record<
  ClientRecordingState,
  { bg: string; label: string; Icon: typeof AlertOctagon; alarm: boolean }
> = {
  RECORDING: {
    bg: "bg-green-600 text-white",
    label: "RECORDING",
    Icon: CheckCircle2,
    alarm: false,
  },
  IDLE: {
    bg: "bg-neutral-500 text-white",
    label: "IDLE",
    Icon: CircleDot,
    alarm: false,
  },
  STARTING_UP: {
    bg: "bg-yellow-500 text-black",
    label: "STARTING…",
    Icon: Clock,
    alarm: false,
  },
  PRINTING_NOT_RECORDING: {
    bg: "bg-red-600 text-white animate-pulse",
    label: "NOT RECORDING",
    Icon: AlertOctagon,
    alarm: true,
  },
  PRINTER_UNREACHABLE: {
    bg: "bg-orange-500 text-white",
    label: "PRINTER UNREACHABLE",
    Icon: WifiOff,
    alarm: true,
  },
  ENDPOINT_UNREACHABLE: {
    bg: "bg-red-600 text-white animate-pulse",
    label: "RECORDER OFFLINE",
    Icon: WifiOff,
    alarm: true,
  },
};

export function RecordingStatusBanner() {
  const { health, clientState } = useRecordingHealth(2_000);
  const [permission, setPermission] = useState<NotificationPermission>(
    typeof Notification !== "undefined" ? Notification.permission : "denied",
  );
  const s = STYLES[clientState];
  const Icon = s.Icon;

  const detail = health?.reason ?? "no health check yet";
  // Optional-chain past `spool`/`build` too: during a deploy the tab can hold
  // a stale pre-upgrade payload (old `db` shape) against the new code.
  const telemetryLag = health?.spool?.telemetry?.append_lag_ms;
  const buildId = health?.build?.current_build_id;
  const importer = health?.importer;

  const enableAlerts = async () => {
    const p = await requestNotificationPermission();
    setPermission(p);
  };

  return (
    <div className="flex items-center gap-2">
      <div
        className={cn(
          "flex items-center gap-2 px-3 py-1 rounded-base border-2 border-border font-heading text-xs shadow-shadow",
          s.bg,
        )}
        title={detail}
      >
        <Icon className="size-3.5" />
        <span className="tracking-wide">{s.label}</span>
        {clientState === "RECORDING" && telemetryLag != null && (
          <span className="opacity-80 text-[10px] font-mono">
            build {buildId} · lag {telemetryLag}ms
          </span>
        )}
        {clientState === "PRINTING_NOT_RECORDING" && telemetryLag != null && (
          <span className="opacity-90 text-[10px] font-mono">
            {(telemetryLag / 1000).toFixed(0)}s stale
          </span>
        )}
        {clientState === "IDLE" && importer != null && (
          <span className="opacity-80 text-[10px] font-mono">
            importing build {importer.buildId} · {importer.stream} · {importer.rowsInserted.toLocaleString()} rows
          </span>
        )}
      </div>
      {s.alarm && permission === "default" && (
        <button
          onClick={enableAlerts}
          className="flex items-center gap-1 px-2 py-1 rounded-base border-2 border-border text-[10px] bg-secondary-background hover:translate-x-boxShadowX hover:translate-y-boxShadowY shadow-shadow hover:shadow-none"
          title="Enable desktop notifications on recording failure"
        >
          <Bell className="size-3" />
          Enable alerts
        </button>
      )}
    </div>
  );
}
