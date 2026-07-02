import { useEffect, useMemo, useRef, useState } from "react";
import { Play, Pause, SkipBack, Radio } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useReplayManifest } from "@/hooks/useReplayManifest";
import { useSpoolManifest } from "@/hooks/useSpoolManifest";
import { renderMatrixToCanvas, matrixStats } from "@/lib/thermal";

// Speeds are multipliers on wall-clock. 1x = real time; higher fast-forwards.
const SPEEDS = [1, 4, 16, 64] as const;
type Speed = (typeof SPEEDS)[number];

interface BuildOption {
  id: number;
  job_name: string | null;
  started_at: string;
  ended_at: string | null;
}

// Normalized shape both the DB and the spool sources reduce to, so the view
// component doesn't care where the frames came from.
interface NormFrame {
  tsMs: number;
  src: string;
}
interface NormManifest {
  startMs: number;
  endMs: number;
  framesByKind: Record<string, NormFrame[]>;
  events: { tsMs: number; label: string }[];
}

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

// Largest frame at-or-before the playhead. null if the playhead precedes the
// first frame (e.g. scrubbed before any capture).
function nearestSrc(frames: NormFrame[] | undefined, playheadMs: number): string | null {
  if (!frames || frames.length === 0) return null;
  if (frames[0]!.tsMs > playheadMs) return null;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (frames[mid]!.tsMs <= playheadMs) lo = mid;
    else hi = mid - 1;
  }
  return frames[lo]!.src;
}

function FrameTile({ title, src }: { title: string; src: string | null }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-heading opacity-70">{title}</div>
      {src ? (
        <img src={src} alt={title} className="block w-full border-2 border-border bg-background object-contain" />
      ) : (
        <div className="w-full aspect-video border-2 border-border bg-background flex items-center justify-center text-xs opacity-50">
          no frame at this time
        </div>
      )}
    </div>
  );
}

// On-disk bed-matrix (raw thermal) frame shape, as written by bedmatrix.ts.
interface RawThermalFrame {
  ts: string;
  width: number;
  height: number;
  values: number[];
}

// Raw temperature matrix at the playhead. Unlike the image tiles this is JSON,
// so we fetch it and paint it with the shared plasma colormap — matching the
// Dashboard's live "raw" thermal view.
function RawThermalTile({ src }: { src: string | null }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [frame, setFrame] = useState<RawThermalFrame | null>(null);

  useEffect(() => {
    if (!src) {
      setFrame(null);
      return;
    }
    const ac = new AbortController();
    fetch(src, { signal: ac.signal })
      .then((r) => r.json() as Promise<RawThermalFrame>)
      .then((f) => setFrame(f))
      .catch(() => {
        /* aborted or missing — leave prior frame */
      });
    return () => ac.abort();
  }, [src]);

  const stats = useMemo(() => (frame ? matrixStats(frame.values) : null), [frame]);

  useEffect(() => {
    if (frame && canvasRef.current) {
      renderMatrixToCanvas(canvasRef.current, frame.width, frame.height, frame.values);
    }
  }, [frame]);

  return (
    <div className="flex flex-col gap-1">
      <div className="text-xs font-heading opacity-70">Thermal (raw)</div>
      {frame ? (
        <>
          <canvas
            ref={canvasRef}
            className="block w-full border-2 border-border bg-background"
            style={{ imageRendering: "pixelated", aspectRatio: "4 / 3" }}
          />
          {stats && (
            <div className="grid grid-cols-3 gap-2 text-[10px]">
              <div className="flex justify-between">
                <span className="opacity-70">min</span>
                <span className="font-heading">{stats.min.toFixed(1)}°</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-70">avg</span>
                <span className="font-heading">{stats.avg.toFixed(1)}°</span>
              </div>
              <div className="flex justify-between">
                <span className="opacity-70">max</span>
                <span className="font-heading">{stats.max.toFixed(1)}°</span>
              </div>
            </div>
          )}
        </>
      ) : (
        <div
          className="w-full border-2 border-border bg-background flex items-center justify-center text-xs opacity-50"
          style={{ aspectRatio: "4 / 3" }}
        >
          no frame at this time
        </div>
      )}
    </div>
  );
}

// Presentational player. `norm` may grow over time for a live build; `isLive`
// switches on follow-the-edge behavior.
function PlaybackView({ norm, isLive }: { norm: NormManifest; isLive: boolean }) {
  const { startMs, endMs } = norm;
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState<Speed>(1);
  // Live builds default to pinning the playhead to the latest recorded frame.
  const [following, setFollowing] = useState(isLive);

  // Seed the playhead: live → live edge, recorded → build start.
  useEffect(() => {
    if (playheadMs === null) setPlayheadMs(isLive ? endMs : startMs);
  }, [playheadMs, isLive, startMs, endMs]);

  // Follow the live edge: keep the playhead glued to endMs as new frames arrive.
  useEffect(() => {
    if (following) setPlayheadMs(endMs);
  }, [following, endMs]);

  // Auto-advance loop (scrub playback). Disabled while following the live edge.
  const lastRef = useRef(0);
  useEffect(() => {
    if (!playing || following) return;
    lastRef.current = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const dt = now - lastRef.current;
      lastRef.current = now;
      setPlayheadMs((p) => (p == null ? p : Math.min(endMs, p + dt * speed)));
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [playing, following, speed, endMs]);

  // Pause when scrub playback reaches the end.
  useEffect(() => {
    if (playing && !following && playheadMs != null && playheadMs >= endMs) setPlaying(false);
  }, [playing, following, playheadMs, endMs]);

  if (playheadMs === null) return <div className="text-sm opacity-60">Loading…</div>;

  const totalMs = Math.max(1, endMs - startMs);
  const atEnd = playheadMs >= endMs;

  const togglePlay = () => {
    setFollowing(false); // playing = manual scrub playback, not live-follow
    if (!playing && atEnd) setPlayheadMs(startMs);
    setPlaying((p) => !p);
  };

  const scrub = (ms: number) => {
    setFollowing(false);
    setPlayheadMs(ms);
  };

  const goLive = () => {
    setPlaying(false);
    setFollowing(true);
    setPlayheadMs(endMs);
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <FrameTile title="Chamber" src={nearestSrc(norm.framesByKind["chamber"], playheadMs)} />
        <FrameTile title="Thermal (gif)" src={nearestSrc(norm.framesByKind["thermal"], playheadMs)} />
        <RawThermalTile src={nearestSrc(norm.framesByKind["bedmatrix"], playheadMs)} />
        <FrameTile title="Galvo plot" src={nearestSrc(norm.framesByKind["galvo"], playheadMs)} />
      </div>

      {/* Transport controls */}
      <div className="flex items-center gap-2 flex-wrap">
        <button
          onClick={() => {
            setPlaying(false);
            scrub(startMs);
          }}
          className="flex items-center justify-center size-7 rounded-base border-2 border-border bg-secondary-background shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none"
          title="Back to start"
        >
          <SkipBack className="size-3.5" />
        </button>
        <button
          onClick={togglePlay}
          className="flex items-center justify-center size-7 rounded-base border-2 border-border bg-main text-main-foreground shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none"
          title={playing ? "Pause" : "Play"}
        >
          {playing ? <Pause className="size-3.5" /> : <Play className="size-3.5" />}
        </button>
        <div className="ml-1 flex gap-1">
          {SPEEDS.map((sp) => (
            <button
              key={sp}
              onClick={() => setSpeed(sp)}
              className={
                "px-2 py-0.5 text-[10px] font-heading rounded-base border-2 border-border " +
                (speed === sp
                  ? "bg-main text-main-foreground shadow-shadow"
                  : "bg-secondary-background hover:translate-x-boxShadowX hover:translate-y-boxShadowY shadow-shadow hover:shadow-none")
              }
            >
              {sp}×
            </button>
          ))}
        </div>
        {isLive && (
          <button
            onClick={goLive}
            className={
              "ml-1 flex items-center gap-1 px-2 py-0.5 text-[10px] font-heading rounded-base border-2 border-border " +
              (following
                ? "bg-red-600 text-white shadow-shadow"
                : "bg-secondary-background hover:translate-x-boxShadowX hover:translate-y-boxShadowY shadow-shadow hover:shadow-none")
            }
            title="Jump to live edge"
          >
            <Radio className={"size-3 " + (following ? "animate-pulse" : "")} />
            LIVE
          </button>
        )}
        <span className="ml-auto text-xs font-heading">
          {fmtTime(playheadMs)} <span className="opacity-50">+{fmtOffset(playheadMs - startMs)}</span>
        </span>
      </div>

      {/* Draggable scrub bar with event tick-marks */}
      <div className="grid gap-1">
        <div className="relative h-3">
          {norm.events.map((e, i) => {
            const pct = Math.max(0, Math.min(100, ((e.tsMs - startMs) / totalMs) * 100));
            return (
              <div
                key={i}
                className="absolute -translate-x-1/2 cursor-pointer"
                style={{ left: `${pct}%` }}
                title={e.label}
                onClick={() => scrub(e.tsMs)}
              >
                <div className="w-px h-3 bg-main" />
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
          onChange={(e) => scrub(Number(e.target.value))}
          className="w-full accent-[var(--main)]"
        />
        <div className="flex items-center justify-between text-[10px] opacity-70 font-base">
          <span>{fmtTime(startMs)}</span>
          <span>{fmtTime(endMs)}</span>
        </div>
      </div>
    </div>
  );
}

// Completed build: frames + events come from Postgres via the manifest.
function DonePlayback({ buildId }: { buildId: number }) {
  const { manifest, error } = useReplayManifest(buildId);
  const norm = useMemo<NormManifest | null>(() => {
    if (!manifest) return null;
    const framesByKind: Record<string, NormFrame[]> = {};
    for (const [kind, arr] of Object.entries(manifest.framesByKind)) {
      framesByKind[kind] = arr.map((f) => ({ tsMs: f.tsMs, src: `/api/frames/${f.id}` }));
    }
    return {
      startMs: new Date(manifest.build.started_at).getTime(),
      endMs: manifest.build.ended_at ? new Date(manifest.build.ended_at).getTime() : Date.now(),
      framesByKind,
      events: manifest.events.map((e) => ({
        tsMs: new Date(e.ts).getTime(),
        label: `${e.kind}${e.message ? ` · ${e.message}` : ""}`,
      })),
    };
  }, [manifest]);

  if (error) return <div className="text-sm opacity-70">Failed to load build: {error}</div>;
  if (!norm) return <div className="text-sm opacity-60">Loading…</div>;
  return <PlaybackView norm={norm} isLive={false} />;
}

// In-progress build: frames come from the NVMe spool (polled); no DB rows yet.
function LivePlayback({ buildId }: { buildId: number }) {
  const { manifest, error } = useSpoolManifest(buildId, 1500);
  const norm = useMemo<NormManifest | null>(() => {
    if (!manifest) return null;
    const framesByKind: Record<string, NormFrame[]> = {};
    let latest = 0;
    for (const [kind, arr] of Object.entries(manifest.framesByKind)) {
      framesByKind[kind] = arr.map((f) => {
        if (f.tsMs > latest) latest = f.tsMs;
        return { tsMs: f.tsMs, src: `/api/frames/spool/${buildId}?path=${encodeURIComponent(f.path)}` };
      });
    }
    const startMs = new Date(manifest.build.started_at).getTime();
    return { startMs, endMs: Math.max(latest, startMs + 1), framesByKind, events: [] };
  }, [manifest, buildId]);

  if (error && !norm) return <div className="text-sm opacity-70">Failed to load live spool: {error}</div>;
  if (!norm) return <div className="text-sm opacity-60">Loading…</div>;
  return <PlaybackView norm={norm} isLive />;
}

export function PlaybackCard() {
  const [builds, setBuilds] = useState<BuildOption[] | null>(null);
  const [buildId, setBuildId] = useState<number | null>(null);

  // Poll the builds list so a build that starts recording shows up (and becomes
  // the default) without a reload. Live builds (ended_at null) sort first.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const rows = (await fetch("/api/builds").then((r) => r.json())) as BuildOption[];
        if (cancelled) return;
        const live = rows.filter((b) => !b.ended_at);
        const done = rows.filter((b) => b.ended_at);
        setBuilds([...live, ...done]);
        // Default once: prefer the live build so the card opens on "now recording".
        setBuildId((prev) => prev ?? live[0]?.id ?? done[0]?.id ?? null);
      } catch {
        /* swallow */
      }
    };
    void load();
    const id = setInterval(load, 5000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  const selected = builds?.find((b) => b.id === buildId) ?? null;
  const isLive = selected != null && !selected.ended_at;

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <CardTitle className="flex items-center gap-2">
          Playback
          {isLive && (
            <span className="inline-flex items-center gap-1 text-[10px] text-red-600">
              <Radio className="size-3 animate-pulse" /> LIVE
            </span>
          )}
        </CardTitle>
        {builds && builds.length > 0 && (
          <select
            value={buildId ?? ""}
            onChange={(e) => setBuildId(Number(e.target.value))}
            className="text-xs font-heading rounded-base border-2 border-border bg-secondary-background px-2 py-1 shadow-shadow"
          >
            {builds.map((b) => (
              <option key={b.id} value={b.id}>
                {b.ended_at ? "" : "● "}#{b.id}
                {b.job_name ? ` · ${b.job_name}` : ""} · {new Date(b.started_at).toLocaleDateString()}
              </option>
            ))}
          </select>
        )}
      </CardHeader>
      <CardContent>
        {builds && builds.length === 0 ? (
          <div className="text-sm opacity-60">No builds to play back yet.</div>
        ) : buildId == null ? (
          <div className="text-sm opacity-60">Loading builds…</div>
        ) : isLive ? (
          <LivePlayback key={buildId} buildId={buildId} />
        ) : (
          <DonePlayback key={buildId} buildId={buildId} />
        )}
      </CardContent>
    </Card>
  );
}
