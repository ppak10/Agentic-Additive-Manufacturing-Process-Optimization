import { useEffect, useState } from "react";
import { ExpandableCard } from "@/components/ui/expandable-card";

// Firmware-rendered galvo plot, polled as PNG. A client-side "trace" view
// once lived here, drawing MOVE_XY/SET_LASER from the plugin's command
// stream — removed 2026-07-15 along with the plotter_commands pipeline: the
// stream never carried data (slicer bypasses the intercepted DI plotter and
// the LoggingMovementClient feeder is disabled over a boot-hang DI cycle;
// see wiki Roadmap phase 5). Restore from git if that fix ever lands.
export function GalvoTile({ intervalMs = 250 }: { intervalMs?: number }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return (
    <ExpandableCard title="Galvo">
      <img
        src={`/api/camera/galvo.png?c=${tick}`}
        alt="Galvo plot"
        className="block w-full border-2 border-border bg-background object-contain"
        style={{ aspectRatio: "1 / 1" }}
      />
      <div className="text-xs opacity-60">firmware-rendered · {Math.round(1000 / intervalMs)} fps</div>
    </ExpandableCard>
  );
}
