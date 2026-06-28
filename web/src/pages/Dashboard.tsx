import { CameraPanel } from "@/panels/CameraPanel";
import { StatusPanel } from "@/panels/StatusPanel";
import { JobPanel } from "@/panels/JobPanel";
import { BuildLayoutPanel } from "@/panels/BuildLayoutPanel";

export function Dashboard() {
  return (
    <>
      <JobPanel />
      <CameraPanel />
      <StatusPanel />
      <BuildLayoutPanel />
    </>
  );
}
