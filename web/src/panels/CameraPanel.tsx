import { useEffect, useState } from "react";
import { ExpandableCard } from "@/components/ui/expandable-card";
import { ThermalTile } from "@/panels/ThermalTile";
import { GalvoTile } from "@/panels/GalvoTile";

function CameraTile({ title, src, intervalMs }: { title: string; src: string; intervalMs: number }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);

  return (
    <ExpandableCard
      title={
        <>
          {title} <span className="opacity-50 font-base">· {Math.round(1000 / intervalMs)} fps</span>
        </>
      }
    >
      <img
        src={`${src}?c=${tick}`}
        alt={title}
        className="block w-full border-2 border-border bg-background object-contain"
      />
    </ExpandableCard>
  );
}

export function CameraPanel() {
  return (
    <div className="p-4 grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <CameraTile title="Chamber" src="/api/camera/chamber.jpg" intervalMs={1000 / 24} />
      <ThermalTile />
      <GalvoTile />
    </div>
  );
}
