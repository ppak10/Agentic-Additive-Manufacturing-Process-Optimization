import { useEffect, useState } from "react";
import { ExpandableCard } from "@/components/ui/expandable-card";
import { ThermalTile } from "@/panels/ThermalTile";
import { GalvoTile } from "@/panels/GalvoTile";
import { useCameraStream } from "@/hooks/useCameraStream";

// Chamber: binary JPEG frames pushed over WebSocket from the plugin's
// ICameraClient.Captured event. No polling — frames arrive at rpicam-vid's
// native 12 fps.
function ChamberTile() {
  const { src, connected } = useCameraStream("/api/camera/chamber/stream");
  return (
    <ExpandableCard
      title={
        <>
          Chamber{" "}
          <span className="opacity-50 font-base">
            · {connected ? "live" : "connecting…"}
          </span>
        </>
      }
    >
      {src ? (
        <img
          src={src}
          alt="Chamber"
          className="block w-full border-2 border-border bg-background object-contain"
        />
      ) : (
        <div className="border-2 border-border bg-background aspect-video flex items-center justify-center text-xs opacity-40">
          waiting for stream…
        </div>
      )}
    </ExpandableCard>
  );
}

export function CameraPanel() {
  // Galvo PNG still comes from the firmware's one-shot HTTP endpoint — there's
  // no event-driven source for it. GalvoTile manages its own polling internally.
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
      <ChamberTile />
      <ThermalTile />
      <GalvoTile />
    </div>
  );
}
