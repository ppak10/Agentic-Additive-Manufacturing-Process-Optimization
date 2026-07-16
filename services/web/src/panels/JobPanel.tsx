import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import type { JobStatus } from "@/hooks/useJob";
import { formatDuration } from "@/lib/utils";

// Split PascalCase (with digits) into a spaced form so the phase badge reads
// naturally ("HeatingBedPreparation" → "Heating Bed Preparation", "Heating3"
// → "Heating 3"). Kept in this file since JobPanel is the only consumer.
function prettifyPhase(phase: string): string {
  return phase.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/([A-Za-z])(\d)/g, "$1 $2");
}

// neobrutalism Progress + a centered percentage readout overlay
function ProgressBar({ percent }: { percent: number }) {
  const clamped = Math.max(0, Math.min(100, percent));
  return (
    <div className="relative w-full">
      <Progress value={clamped} className="h-6" />
      <div className="absolute inset-0 flex items-center justify-center text-[10px] font-heading mix-blend-difference text-white pointer-events-none">
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
              {/* layer counter in the badge — phaseDone/phaseTotal are the
                  layer counts during the Layers phase specifically */}
              {job?.phase === "Layers" && job.phaseDone != null && job.phaseTotal != null && (
                <span className="ml-1">
                  {job.phaseDone} / {job.phaseTotal}
                </span>
              )}
            </Badge>
            {job?.jobName && <span className="opacity-70 font-base">· {job.jobName}</span>}
            {phaseIsActive && job?.remaining && (
              <span className="ml-auto text-xs font-base opacity-70">
                {formatDuration(job.remaining)} left
              </span>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {isActive ? (
            <ProgressBar percent={job?.progress ?? 0} />
          ) : (
            <div className="text-xs opacity-60">No active job — printer idle.</div>
          )}
        </CardContent>
      </Card>
  );
}
