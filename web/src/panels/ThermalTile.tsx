import { useEffect, useMemo, useRef, useState } from "react";
import { ExpandableCard } from "@/components/ui/expandable-card";
import { useBedMatrix } from "@/hooks/useBedMatrix";
import { renderMatrixToCanvas, matrixStats } from "@/lib/thermal";
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

function RawMatrixView() {
  const { frame, connected } = useBedMatrix();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stats = useMemo(() => (frame ? matrixStats(frame.data.values) : null), [frame]);

  useEffect(() => {
    if (!frame || !canvasRef.current) return;
    renderMatrixToCanvas(canvasRef.current, frame.data.width, frame.data.height, frame.data.values);
  }, [frame]);

  return (
    <>
      <canvas
        ref={canvasRef}
        className="block w-full border-2 border-border bg-background"
        style={{ imageRendering: "pixelated", aspectRatio: "32 / 24" }}
      />
      {stats ? (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <div className="flex justify-between">
            <span className="opacity-70">min</span>
            <span className="font-heading">{stats.min.toFixed(1)} °C</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">avg</span>
            <span className="font-heading">{stats.avg.toFixed(1)} °C</span>
          </div>
          <div className="flex justify-between">
            <span className="opacity-70">max</span>
            <span className="font-heading">{stats.max.toFixed(1)} °C</span>
          </div>
        </div>
      ) : (
        <div className="text-xs opacity-60">{connected ? "waiting for first frame…" : "disconnected"}</div>
      )}
    </>
  );
}

function GifView({ intervalMs = 250 }: { intervalMs?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return (
    <>
      <img
        src={`/api/camera/thermal.gif?c=${tick}`}
        alt="Thermal GIF"
        className="block w-full border-2 border-border bg-background object-contain"
      />
      <div className="text-xs opacity-60">firmware-rendered · {Math.round(1000 / intervalMs)} fps</div>
    </>
  );
}

type Tab = "raw" | "gif";

export function ThermalTile() {
  const [tab, setTab] = useState<Tab>("raw");
  return (
    <ExpandableCard
      title="Thermal"
      headerRight={
        <div className="flex gap-1">
          <TabButton active={tab === "raw"} onClick={() => setTab("raw")}>raw</TabButton>
          <TabButton active={tab === "gif"} onClick={() => setTab("gif")}>gif</TabButton>
        </div>
      }
    >
      {tab === "raw" ? <RawMatrixView /> : <GifView />}
    </ExpandableCard>
  );
}
