import { useEffect, useMemo, useState } from "react";
import { useParams, Navigate } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useReplayManifest, findNearestFrame } from "@/hooks/useReplayManifest";
import { useReplayWindow, latestPerSensor, type TelemetryRow } from "@/hooks/useReplayWindow";

const TELEMETRY_KINDS = [
  "temp.current",
  "temp.target",
  "power",
  "power.current",
  "power.required",
  "power.max",
  "position.x",
  "position.y",
  "position.z1",
  "position.z2",
  "position.r",
  "lights.enabled",
] as const;

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function fmtOffset(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
}

function FrameTile({ title, src }: { title: string; src: string | null }) {
  return (
    <Card>
      <CardHeader><CardTitle>{title}</CardTitle></CardHeader>
      <CardContent>
        {src ? (
          <img
            src={src}
            alt={title}
            className="block w-full border-2 border-border bg-background object-contain"
          />
        ) : (
          <div className="w-full aspect-video border-2 border-border bg-secondary-background flex items-center justify-center text-xs opacity-50">
            no frame at this time
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SensorGrid({ rows, playheadMs }: { rows: TelemetryRow[]; playheadMs: number }) {
  const latest = useMemo(() => latestPerSensor(rows, playheadMs), [rows, playheadMs]);
  const byKind = useMemo(() => {
    const out: Record<string, TelemetryRow[]> = {};
    for (const v of latest.values()) (out[v.kind] ??= []).push(v);
    for (const k of Object.keys(out)) out[k]!.sort((a, b) => a.sensor_id.localeCompare(b.sensor_id));
    return out;
  }, [latest]);

  const positions = TELEMETRY_KINDS.filter((k) => k.startsWith("position.")).flatMap((k) =>
    (byKind[k] ?? []).map((r) => ({ label: r.kind.replace("position.", ""), v: r.value })),
  );
  const temps = byKind["temp.current"] ?? [];
  const targets = new Map((byKind["temp.target"] ?? []).map((r) => [r.sensor_id, r.value]));
  const power = (byKind["power"] ?? []).filter((r) => r.value > 0.01);
  const pmCurrent = byKind["power.current"]?.[0]?.value;
  const pmMax = byKind["power.max"]?.[0]?.value;

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
      <Card>
        <CardHeader><CardTitle>Positions</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-xs">
          {positions.map((p) => {
            const isZ = p.label === "z1" || p.label === "z2";
            return (
              <div key={p.label} className="flex justify-between">
                <span className="opacity-70">{p.label}</span>
                <span className="font-heading">
                  {isZ ? (p.v / 1000).toFixed(3) : p.v.toFixed(2)}
                  {isZ && <span className="opacity-60 ml-1">mm</span>}
                </span>
              </div>
            );
          })}
          {positions.length === 0 && <span className="opacity-50">no data in window</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Temperatures</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-xs">
          {temps.map((t) => {
            const target = targets.get(t.sensor_id);
            return (
              <div key={t.sensor_id} className="flex justify-between">
                <span className="opacity-70">{t.sensor_id}</span>
                <span className="font-heading">
                  {t.value.toFixed(1)}
                  {target != null && ` / ${target.toFixed(1)}`}
                  <span className="opacity-60 ml-1">°C</span>
                </span>
              </div>
            );
          })}
          {temps.length === 0 && <span className="opacity-50">no data in window</span>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle>Power</CardTitle></CardHeader>
        <CardContent className="grid gap-1 text-xs">
          {pmCurrent != null && (
            <div className="flex justify-between">
              <span className="opacity-70">powerman</span>
              <span className="font-heading">
                {pmCurrent.toFixed(0)}
                {pmMax != null && ` / ${pmMax.toFixed(0)}`}
                <span className="opacity-60 ml-1">W</span>
              </span>
            </div>
          )}
          {power.map((p) => (
            <div key={p.sensor_id} className="flex justify-between">
              <span className="opacity-70">{p.sensor_id}</span>
              <span className="font-heading">{p.value.toFixed(2)}</span>
            </div>
          ))}
          {power.length === 0 && pmCurrent == null && <span className="opacity-50">no data in window</span>}
        </CardContent>
      </Card>
    </div>
  );
}

function Timeline({
  startMs,
  endMs,
  playheadMs,
  onChange,
  events,
}: {
  startMs: number;
  endMs: number;
  playheadMs: number;
  onChange: (ms: number) => void;
  events: { tsMs: number; label: string }[];
}) {
  const totalMs = Math.max(1, endMs - startMs);
  return (
    <div className="grid gap-2">
      <div className="relative h-4">
        {events.map((e, i) => {
          const pct = Math.max(0, Math.min(100, ((e.tsMs - startMs) / totalMs) * 100));
          return (
            <div
              key={i}
              className="absolute -translate-x-1/2 cursor-pointer"
              style={{ left: `${pct}%` }}
              title={e.label}
              onClick={() => onChange(e.tsMs)}
            >
              <div className="w-px h-4 bg-main"></div>
            </div>
          );
        })}
      </div>
      <input
        type="range"
        min={startMs}
        max={endMs}
        step={100}
        value={playheadMs}
        onChange={(e) => onChange(Number(e.target.value))}
        className="w-full accent-[var(--main)]"
      />
      <div className="flex items-center justify-between text-xs opacity-70 font-base">
        <span>{fmtTime(startMs)}</span>
        <span className="font-heading">
          {fmtTime(playheadMs)} <span className="opacity-50">+{fmtOffset(playheadMs - startMs)}</span>
        </span>
        <span>{fmtTime(endMs)}</span>
      </div>
    </div>
  );
}

export function Replay() {
  const { buildId } = useParams<{ buildId: string }>();
  const id = Number(buildId);
  if (!Number.isFinite(id) || id <= 0) return <Navigate to="/builds" replace />;

  const { manifest, error } = useReplayManifest(id);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);

  useEffect(() => {
    if (manifest && playheadMs === null) {
      setPlayheadMs(new Date(manifest.build.started_at).getTime());
    }
  }, [manifest, playheadMs]);

  const kinds = useMemo(() => [...TELEMETRY_KINDS], []);
  const rows = useReplayWindow(id, playheadMs ?? 0, kinds);

  if (error) {
    return <div className="p-4 text-sm opacity-70">Failed to load manifest: {error}</div>;
  }
  if (!manifest || playheadMs === null) {
    return <div className="p-4 text-sm opacity-60">Loading replay…</div>;
  }

  const startMs = new Date(manifest.build.started_at).getTime();
  const endMs = manifest.build.ended_at
    ? new Date(manifest.build.ended_at).getTime()
    : Date.now();

  const chamberId = findNearestFrame(manifest.framesByKind["chamber"], playheadMs);
  const thermalId = findNearestFrame(manifest.framesByKind["thermal"], playheadMs);
  const galvoId = findNearestFrame(manifest.framesByKind["galvo"], playheadMs);

  const eventMarks = manifest.events.map((e) => ({
    tsMs: new Date(e.ts).getTime(),
    label: `${e.kind}${e.message ? ` · ${e.message}` : ""}`,
  }));

  return (
    <div className="p-4 grid gap-4">
      {/* build identity lives in the breadcrumb + build tabs (BuildLayout);
          keep only the job label + live/done status here */}
      <div className="flex items-center gap-3">
        <span className="text-sm opacity-70">{manifest.build.job_name ?? "(unnamed)"}</span>
        <Badge variant={manifest.build.ended_at ? "neutral" : "default"}>
          {manifest.build.ended_at ? "done" : "live"}
        </Badge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        <FrameTile title="Chamber" src={chamberId ? `/api/frames/${chamberId}` : null} />
        <FrameTile title="Thermal" src={thermalId ? `/api/frames/${thermalId}` : null} />
        <FrameTile title="Galvo plot" src={galvoId ? `/api/frames/${galvoId}` : null} />
      </div>

      <Card>
        <CardHeader><CardTitle>Timeline</CardTitle></CardHeader>
        <CardContent>
          <Timeline
            startMs={startMs}
            endMs={endMs}
            playheadMs={playheadMs}
            onChange={setPlayheadMs}
            events={eventMarks}
          />
        </CardContent>
      </Card>

      <SensorGrid rows={rows} playheadMs={playheadMs} />
    </div>
  );
}
