import { useEffect, useRef, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useGalvoStream } from "@/hooks/useGalvoStream";
import { cn } from "@/lib/utils";

const ALPHA_BUCKETS = 8;

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
  const { pointsRef, connected, stats, clear } = useGalvoStream();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    let stop = false;
    const css = getComputedStyle(document.documentElement);
    const strokeColor = css.getPropertyValue("--main").trim() || "#ff7a05";

    const draw = () => {
      if (stop) return;
      requestAnimationFrame(draw);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const pts = pointsRef.current;

      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth;
      const cssH = canvas.clientHeight;
      const w = Math.floor(cssW * dpr);
      const h = Math.floor(cssH * dpr);
      if (canvas.width !== w) canvas.width = w;
      if (canvas.height !== h) canvas.height = h;

      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.clearRect(0, 0, w, h);

      if (pts.length < 2) return;

      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }
      const padX = Math.max((maxX - minX) * 0.05, 0.5);
      const padY = Math.max((maxY - minY) * 0.05, 0.5);
      minX -= padX; maxX += padX;
      minY -= padY; maxY += padY;
      const rangeX = Math.max(maxX - minX, 1e-9);
      const rangeY = Math.max(maxY - minY, 1e-9);

      const toX = (x: number) => ((x - minX) / rangeX) * w;
      const toY = (y: number) => h - ((y - minY) / rangeY) * h;

      ctx.strokeStyle = strokeColor;
      ctx.lineWidth = Math.max(1, dpr);
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const bucketSize = Math.ceil(pts.length / ALPHA_BUCKETS);
      for (let bucket = 0; bucket < ALPHA_BUCKETS; bucket++) {
        const alpha = 0.08 + 0.92 * (bucket / (ALPHA_BUCKETS - 1));
        const start = bucket * bucketSize;
        const end = Math.min(start + bucketSize + 1, pts.length);
        if (end - start < 2) continue;
        ctx.globalAlpha = alpha;
        ctx.beginPath();
        ctx.moveTo(toX(pts[start]!.x), toY(pts[start]!.y));
        for (let i = start + 1; i < end; i++) {
          ctx.lineTo(toX(pts[i]!.x), toY(pts[i]!.y));
        }
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    };
    requestAnimationFrame(draw);
    return () => { stop = true; };
  }, [pointsRef]);

  return (
    <>
      <div className="flex items-center gap-2 text-xs">
        <Badge variant={connected ? "default" : "neutral"}>
          {connected ? `${stats.count} pts · ${stats.fps} Hz` : "off"}
        </Badge>
        <button
          onClick={clear}
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
            waiting for motion…
          </div>
        )}
      </div>
      {stats.latest && (
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
        plots commanded stepper x/y from <code>PositionChangedHighFrequency</code>. Note: galvo raster moves don't fire this event — only homing and aux moves do. Real galvo trace lives on the PNG tab.
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
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>Galvo</span>
          <div className="ml-auto flex gap-1">
            <TabButton active={tab === "png"} onClick={() => setTab("png")}>png</TabButton>
            <TabButton active={tab === "trace"} onClick={() => setTab("trace")}>trace</TabButton>
          </div>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {tab === "png" ? <PngView /> : <TraceView />}
      </CardContent>
    </Card>
  );
}
