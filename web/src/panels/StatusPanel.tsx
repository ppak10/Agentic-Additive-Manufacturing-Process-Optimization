import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useStream, type StateSnapshot } from "@/hooks/useStream";

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

function PositionsCard({ s }: { s: StateSnapshot }) {
  return (
    <Card>
      <CardHeader><CardTitle>Positions</CardTitle></CardHeader>
      <CardContent className="grid gap-1">
        <MetricRow label="x" value={s.position.x.toFixed(2)} />
        <MetricRow label="y" value={s.position.y.toFixed(2)} />
        <MetricRow label="z1" value={(s.position.z1 / 1000).toFixed(3)} unit="mm" />
        <MetricRow label="z2" value={(s.position.z2 / 1000).toFixed(3)} unit="mm" />
        <MetricRow label="r" value={s.position.r.toFixed(2)} />
      </CardContent>
    </Card>
  );
}

function TempsCard({ s }: { s: StateSnapshot }) {
  return (
    <Card>
      <CardHeader><CardTitle>Temperatures</CardTitle></CardHeader>
      <CardContent className="grid gap-1">
        {s.temperature.entries.map((e) => {
          const hasTarget = e.targetTemperature != null;
          const value = hasTarget
            ? `${e.currentTemperature.toFixed(1)} / ${e.targetTemperature!.toFixed(1)}`
            : e.currentTemperature.toFixed(1);
          return (
            <div key={e.id} className="flex justify-between items-center text-xs">
              <span className="opacity-70 flex items-center gap-1.5">
                {hasTarget && (
                  <span
                    className={
                      e.targetReached
                        ? "inline-block size-1.5 rounded-full bg-main"
                        : "inline-block size-1.5 rounded-full border border-border"
                    }
                    title={e.targetReached ? "target reached" : "target not reached"}
                  />
                )}
                {e.id}
              </span>
              <span className="font-heading">
                {value}
                <span className="opacity-60 ml-1">°C</span>
                <span className="opacity-40 ml-1.5 font-base">avg {e.averageTemperature.toFixed(1)}</span>
              </span>
            </div>
          );
        })}
      </CardContent>
    </Card>
  );
}

function PowerCard({ s }: { s: StateSnapshot }) {
  const pm = s.power.powerman;
  const throttling = pm.requiredPower > pm.maxPower;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Power</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1">
        <div className="flex justify-between text-xs">
          <span className="opacity-70 flex items-center gap-1.5">
            {throttling && (
              <span
                className="inline-block size-1.5 rounded-full bg-main"
                title={`throttling: required ${pm.requiredPower.toFixed(0)}W exceeds max ${pm.maxPower.toFixed(0)}W`}
              />
            )}
            powerman
          </span>
          <span className="font-heading">
            {pm.currentPower.toFixed(0)} / {pm.requiredPower.toFixed(0)} / {pm.maxPower.toFixed(0)}
            <span className="opacity-60 ml-1">W</span>
          </span>
        </div>
        {pm.poweredPinsDescription && (
          <div className="text-[10px] opacity-50 font-base break-words">{pm.poweredPinsDescription}</div>
        )}
        {s.power.entries.map((e) => (
          <MetricRow key={e.id} label={e.id} value={e.power.toFixed(2)} />
        ))}
      </CardContent>
    </Card>
  );
}

function LightsCard({ s }: { s: StateSnapshot }) {
  return (
    <Card>
      <CardHeader><CardTitle>Lights</CardTitle></CardHeader>
      <CardContent className="grid gap-1">
        <MetricRow label="enabled" value={s.lights.isEnabled ? "on" : "off"} />
        <MetricRow label="count" value={s.lights.lightCount} />
      </CardContent>
    </Card>
  );
}

export function StatusPanel() {
  const { snapshot, connected } = useStream();

  return (
    <div className="p-4 grid gap-4">
      <div className="flex items-center gap-3">
        <Badge variant={connected ? "default" : "neutral"}>
          {connected ? "live" : "disconnected"}
        </Badge>
        {snapshot && (
          <span className="text-xs opacity-60">
            last frame: {new Date(snapshot.respondedAt).toLocaleTimeString()}
          </span>
        )}
      </div>

      {snapshot ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
          <PositionsCard s={snapshot.data} />
          <TempsCard s={snapshot.data} />
          <PowerCard s={snapshot.data} />
          <LightsCard s={snapshot.data} />
        </div>
      ) : (
        <div className="text-sm opacity-60">waiting for first frame…</div>
      )}
    </div>
  );
}
