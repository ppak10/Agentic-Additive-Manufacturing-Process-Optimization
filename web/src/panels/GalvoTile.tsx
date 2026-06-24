import { useEffect, useRef, useState } from "react";
import { ExpandableCard } from "@/components/ui/expandable-card";
import { Badge } from "@/components/ui/badge";
import { useCommandStream } from "@/hooks/useCommandStream";
import { cn } from "@/lib/utils";

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "px-2 py-0.5 text-xs font-heading border-2 border-border rounded-base transition-all",
        active
          ? "bg-main text-main-foreground shadow-shadow"
          : "bg-secondary-background text-foreground shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none",
      )}
    >
      {children}
    </button>
  );
}

function TraceView() {
  const { connected, stats, maxXY, frameSinceLastRead, clear } = useCommandStream();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Cross-frame pen state. lastX/lastY in mm bed coords; lastLaser is the
  // most recent SET_LASER value (0..1), used to modulate stroke alpha when
  // we draw a MOVE_XY.
  const penRef = useRef<{ x: number | null; y: number | null; laser: number }>({
    x: null, y: null, laser: 0,
  });

  useEffect(() => {
    let stop = false;
    const css = getComputedStyle(document.documentElement);
    const strokeColor = css.getPropertyValue("--main").trim() || "#ff7a05";

    const draw = () => {
      if (stop) return;
      requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const w = Math.floor(cssW * dpr);
      const h = Math.floor(cssH * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      const delta = frameSinceLastRead();
      if (delta.layerChanged) {
        ctx.clearRect(0, 0, w, h);
        penRef.current = { x: null, y: null, laser: 0 };
      }
      if (delta.commands.length === 0) return;

      // mm → canvas px, bed origin (0,0) → top-left. The firmware bed origin
      // is bottom-left, so flip Y.
      const toX = (mm: number) => (mm / maxXY) * w;
      const toY = (mm: number) => h - (mm / maxXY) * h;

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";

      const pen = penRef.current;
      for (const cmd of delta.commands) {
        if (cmd.op === "SET_LASER") {
          pen.laser = cmd.laser ?? pen.laser;
          continue;
        }
        if (cmd.op !== "MOVE_XY" || cmd.x === null || cmd.y === null) continue;
        if (pen.x !== null && pen.y !== null) {
          // Only render visible strokes — laser off (0) = invisible travel.
          if (pen.laser > 0) {
            ctx.globalAlpha = 0.15 + 0.85 * Math.min(1, pen.laser);
            ctx.beginPath();
            ctx.moveTo(toX(pen.x), toY(pen.y));
            ctx.lineTo(toX(cmd.x), toY(cmd.y));
            ctx.stroke();
          }
        }
        pen.x = cmd.x;
        pen.y = cmd.y;
      }
      ctx.globalAlpha = 1;
    };
    requestAnimationFrame(draw);
    return () => { stop = true; };
  }, [frameSinceLastRead, maxXY]);

  const handleClear = () => {
    clear();
    const canvas = canvasRef.current;
    if (canvas) canvas.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
    penRef.current = { x: null, y: null, laser: 0 };
  };

  return (
    <>
      <div className="flex items-center gap-2 text-xs">
        <Badge variant={connected ? "default" : "neutral"}>
          {connected ? `layer ${stats.currentLayer} · ${stats.count} cmds · ${stats.fps} Hz` : "off"}
        </Badge>
        <button
          onClick={handleClear}
          className="ml-auto text-xs underline opacity-70 hover:opacity-100"
          disabled={stats.count === 0}
        >
          clear
        </button>
      </div>
      <div className="relative">
        <canvas
          ref={canvasRef}
          className="block w-full border-2 border-border bg-background"
          style={{ aspectRatio: "1 / 1" }}
        />
        {stats.count === 0 && (
          <div className="absolute inset-0 flex items-center justify-center text-xs opacity-50 pointer-events-none">
            waiting for commands…
          </div>
        )}
      </div>
      {stats.latest && stats.latest.op === "MOVE_XY" && stats.latest.x !== null && stats.latest.y !== null && (
        <div className="grid grid-cols-2 gap-2 text-xs">
          <div className="flex justify-between">
            <span className="opacity-70">x</span>
            <span className="font-heading">{stats.latest.x.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">y</span>
            <span className="font-heading">{stats.latest.y.toFixed(2)}</span>
          </div>
        </div>
      )}
      <div className="text-[10px] opacity-50">
        commands captured from <code>ICodePlotter.Process</code> — live laser path
      </div>
    </>
  );
}

function PngView({ intervalMs = 250 }: { intervalMs?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return (
    <>
      <img
        src={`/api/camera/galvo.png?c=${tick}`}
        alt="Galvo plot"
        className="block w-full border-2 border-border bg-background object-contain"
        style={{ aspectRatio: "1 / 1" }}
      />
      <div className="text-xs opacity-60">firmware-rendered · {Math.round(1000 / intervalMs)} fps</div>
    </>
  );
}

type Tab = "png" | "trace";

export function GalvoTile() {
  const [tab, setTab] = useState<Tab>("png");
  return (
    <ExpandableCard
      title="Galvo"
      headerRight={
        <div className="flex gap-1">
          <TabButton active={tab === "png"} onClick={() => setTab("png")}>png</TabButton>
          <TabButton active={tab === "trace"} onClick={() => setTab("trace")}>trace</TabButton>
        </div>
      }
    >
      {tab === "png" ? <PngView /> : <TraceView />}
    </ExpandableCard>
  );
}
