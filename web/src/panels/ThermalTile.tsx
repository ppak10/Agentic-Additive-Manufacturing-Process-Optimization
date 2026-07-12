import { useEffect, useMemo, useRef } from "react";
import { ExpandableCard } from "@/components/ui/expandable-card";
import { useBedMatrix } from "@/hooks/useBedMatrix";
import { renderMatrixToCanvas, matrixStats } from "@/lib/thermal";

export function ThermalTile() {
  const { frame, connected } = useBedMatrix();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stats = useMemo(() => (frame ? matrixStats(frame.data.values) : null), [frame]);

  useEffect(() => {
    if (!frame || !canvasRef.current) return;
    renderMatrixToCanvas(canvasRef.current, frame.data.width, frame.data.height, frame.data.values);
  }, [frame]);

  return (
    <ExpandableCard title="Thermal">
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
        <div className="text-xs opacity-60">
          {connected ? "waiting for first frame…" : "disconnected"}
        </div>
      )}
    </ExpandableCard>
  );
}
