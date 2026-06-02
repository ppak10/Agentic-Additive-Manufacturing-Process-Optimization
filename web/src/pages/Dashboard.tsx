import { CameraPanel } from "@/panels/CameraPanel";
import { StatusPanel } from "@/panels/StatusPanel";
import { JobPanel } from "@/panels/JobPanel";

export function Dashboard() {
  return (
    <>
      <JobPanel />
      <CameraPanel />
      <StatusPanel />
    </>
  );
}
