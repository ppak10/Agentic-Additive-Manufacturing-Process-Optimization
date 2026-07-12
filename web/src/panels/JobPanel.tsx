import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MetricRow } from "@/components/ui/metric-row";
import type { JobStatus } from "@/hooks/useJob";
import { formatDuration } from "@/lib/utils";

// Split PascalCase (with digits) into a spaced form so the phase badge reads
// naturally ("HeatingBedPreparation" → "Heating Bed Preparation", "Heating3"
// → "Heating 3"). Kept in this file since JobPanel is the only consumer.
function prettifyPhase(phase: string): string {
  return phase.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2");
}

function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="w-full h-3 border-2 border-border bg-secondary-background relative overflow-hidden">
      <div
        className="h-full bg-main transition-all"
        style={{ width: `${clamped}%` }}
      />
      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-heading mix-blend-difference text-white">
        {clamped.toFixed(1)}%
      </div>
    </div>
  );
}

export function JobPanel({ job }: { job: JobStatus | null }) {
  // isActive: a real print is in progress if phase is set to anything other
  // than NotSet. (Previously we OR'd against jobName, which stayed populated
  // between prints, so the badge never fell back to "idle".)
  const phaseIsActive = job?.phase != null && job.phase !== "NotSet";
  const isActive = phaseIsActive || (job?.jobName != null && job.jobName !== "");

  return (
    <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span>Job</span>
            <Badge variant={phaseIsActive ? "default" : "neutral"}>
              {phaseIsActive ? prettifyPhase(job!.phase!) : "idle"}
            </Badge>
            {job?.jobName && <span className="opacity-70 font-base">· {job.jobName}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {isActive ? (
            <>
              <ProgressBar percent={job?.progress ?? 0} />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <MetricRow label="remaining" value={formatDuration(job?.remaining)} />
                <MetricRow
                  label="layer"
                  value={
                    job?.phaseDone != null && job?.phaseTotal != null
                      ? `${job.phaseDone} / ${job.phaseTotal}`
                      : "—"
                  }
                />
                <MetricRow
                  label="surface target"
                  value={job?.surfaceTarget != null ? job.surfaceTarget.toFixed(1) : "—"}
                  unit={job?.surfaceTarget != null ? "°C" : undefined}
                />
                <MetricRow label="profile" value={job?.printProfileName ?? "—"} />
              </div>
            </>
          ) : (
            <div className="text-xs opacity-60">No active job — printer idle.</div>
          )}
        </CardContent>
      </Card>
  );
}
