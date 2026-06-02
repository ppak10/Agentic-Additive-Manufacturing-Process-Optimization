import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useJob } from "@/hooks/useJob";

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

function MetricRow({ label, value, unit }: { label: string; value: string | number; unit?: string }) {
  return (
    <div className="flex justify-between text-xs">
      <span className="opacity-70">{label}</span>
      <span className="font-heading">
        {value}
        {unit ? <span className="opacity-60 ml-1">{unit}</span> : null}
      </span>
    </div>
  );
}

export function JobPanel() {
  const job = useJob(1000);
  const isActive = job?.phase !== null || job?.jobName !== null;

  return (
    <div className="px-4 pt-4 grid gap-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-3">
            <span>Job</span>
            <Badge variant={isActive ? "default" : "neutral"}>
              {isActive ? "running" : "idle"}
            </Badge>
            {job?.jobName && <span className="opacity-70 font-base">· {job.jobName}</span>}
            {job?.phase && <span className="opacity-70 font-base">· {job.phase}</span>}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {isActive ? (
            <>
              <ProgressBar percent={job?.progress ?? 0} />
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                <MetricRow label="remaining" value={job?.remaining ?? "—"} />
                <MetricRow
                  label="phase"
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
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs opacity-70">
                <MetricRow label="cpu" value={job?.cpuTemp.toFixed(0) ?? "—"} unit="°C" />
                <MetricRow label="gpu" value={job?.gpuTemp.toFixed(0) ?? "—"} unit="°C" />
                <MetricRow label="cpu load" value={(job?.totalCpuLoad ?? 0).toFixed(1)} unit="%" />
                <MetricRow
                  label="mem"
                  value={`${job?.selfUsedMemory ?? 0} / ${job?.totalAvailableMemory ?? 0}`}
                  unit="MB"
                />
              </div>
            </>
          ) : (
            <div className="text-xs opacity-60">No active job — printer idle.</div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
