import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { MetricRow } from "@/components/ui/metric-row";
import { useJob } from "@/hooks/useJob";

// Printer host stats — CPU / GPU temperature, CPU load, memory. These are
// firmware-reported (SLS4All process on the Inova), not the recorder or the
// dashboard host. Populated even between prints via the plugin's /info-style
// telemetry, but the useJob hook only surfaces them during an active print.
export function SystemPanel() {
  const job = useJob(1000);
  const hasData = job !== null;

  return (
    <Card>
        <CardHeader>
          <CardTitle>System</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          {hasData ? (
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
              <MetricRow label="cpu" value={job?.cpuTemp.toFixed(0) ?? "—"} unit="°C" />
              <MetricRow label="gpu" value={job?.gpuTemp.toFixed(0) ?? "—"} unit="°C" />
              <MetricRow label="cpu load" value={(job?.totalCpuLoad ?? 0).toFixed(1)} unit="%" />
              <MetricRow
                label="mem"
                value={`${job?.selfUsedMemory ?? 0} / ${job?.totalAvailableMemory ?? 0}`}
                unit="MB"
              />
            </div>
          ) : (
            <div className="text-xs opacity-60">No telemetry — printer offline or idle.</div>
          )}
        </CardContent>
      </Card>
  );
}
