import { CameraPanel } from "@/panels/CameraPanel";
import { StatusPanel } from "@/panels/StatusPanel";
import { JobPanel } from "@/panels/JobPanel";
import { BuildLayoutPanel } from "@/panels/BuildLayoutPanel";
import { OverridePanel } from "@/panels/OverridePanel";
import { SystemPanel } from "@/panels/SystemPanel";

export function Dashboard() {
  return (
    // Single source of truth for card-to-card spacing. Every panel below
    // renders its Card(s) directly with no outer padding wrapper — this
    // container's `gap-4` (16px) is the only gap you'll see between them.
    <div className="p-4 flex flex-col gap-4">
      <SystemPanel />
      <JobPanel />
      <OverridePanel />
      <BuildLayoutPanel />
      <CameraPanel />
      <StatusPanel />
    </div>
  );
}
