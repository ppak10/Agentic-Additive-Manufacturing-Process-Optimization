import { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import {
  Activity,
  Bot,
  Boxes,
  Database,
  Tag,
  FlaskConical,
  Radar,
  Rss,
  Layers,
  Moon,
  Radio,
  Settings2,
  Sun,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { Dashboard } from "@/pages/Dashboard";
import { Recording } from "@/pages/Recording";
import { Builds } from "@/pages/Builds";
import { BuildCard } from "@/pages/BuildCard";
import { Replay } from "@/pages/Replay";
import { PrintProfiles } from "@/pages/PrintProfiles";
import { Jobs } from "@/pages/Jobs";
import { PowderTuning } from "@/pages/PowderTuning";
import { Agents } from "@/pages/Agents";
import { Services } from "@/pages/Services";
import { MissionControl } from "@/pages/MissionControl";
import { DatasetPage } from "@/pages/Datasets";
import { TelemetryBuildLab } from "@/pages/TelemetryBuildLab";
import { Labeling } from "@/pages/Labeling";
import { usePluginInfo, formatUptime } from "@/hooks/usePluginInfo";
import { useJob, type JobStatus } from "@/hooks/useJob";
import { RecordingStatusBanner } from "@/components/RecordingStatusBanner";

const NAV_GROUPS = [
  {
    label: "Live",
    items: [
      { to: "/mission", label: "Mission Control", icon: Radar, end: false },
      { to: "/", label: "Feed", icon: Rss, end: true },
      { to: "/recording", label: "Recording", icon: Radio, end: false },
    ],
  },
  {
    label: "Library",
    items: [
      { to: "/builds", label: "Builds", icon: Boxes, end: false },
      { to: "/profiles", label: "Profiles", icon: Settings2, end: false },
      { to: "/jobs", label: "Jobs", icon: Layers, end: false },
    ],
  },
  {
    label: "Tuning",
    items: [
      { to: "/powder-tuning", label: "Powder Tuning", icon: FlaskConical, end: false },
    ],
  },
  {
    label: "Agents",
    items: [
      { to: "/agents", label: "Sessions", icon: Bot, end: false },
    ],
  },
  {
    label: "Labeling",
    items: [
      { to: "/labeling", label: "Triage", icon: Tag, end: false },
    ],
  },
  {
    label: "Datasets",
    items: [
      { to: "/datasets/telemetry", label: "Telemetry", icon: Database, end: false },
      { to: "/datasets/database", label: "Database", icon: Database, end: false },
      { to: "/datasets/astm", label: "ASTM", icon: Database, end: false },
      { to: "/datasets/conversations", label: "Conversations", icon: Database, end: false },
      { to: "/datasets/knowledge", label: "Knowledge", icon: Database, end: false },
    ],
  },
  {
    label: "System",
    items: [
      { to: "/services", label: "Services", icon: Activity, end: false },
    ],
  },
] as const;

function AppSidebar({ dark, onToggleDark }: { dark: boolean; onToggleDark: () => void }) {
  const location = useLocation();
  const info = usePluginInfo();

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarMenu>
              {group.items.map((item) => {
                const isActive = item.end
                  ? location.pathname === item.to
                  : location.pathname.startsWith(item.to);
                return (
                  <SidebarMenuItem key={item.to}>
                    <SidebarMenuButton asChild tooltip={item.label} isActive={isActive}>
                      <NavLink to={item.to} end={item.end}>
                        <item.icon />
                        <span>{item.label}</span>
                      </NavLink>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          {info && (
            <SidebarMenuItem>
              <SidebarMenuButton
                tooltip={`plugin v${info.version} · up ${formatUptime(info.uptimeSeconds)}`}
                className="pointer-events-none select-none"
              >
                <span className="text-[10px] opacity-50 truncate">
                  v{info.version} · up {formatUptime(info.uptimeSeconds)}
                </span>
              </SidebarMenuButton>
            </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              tooltip={dark ? "Switch to light mode" : "Switch to dark mode"}
              onClick={onToggleDark}
            >
              {dark ? <Sun /> : <Moon />}
              <span>{dark ? "Light mode" : "Dark mode"}</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

function AppShell() {
  const [dark, setDark] = useState(false);
  // Single useJob call for the whole app — used by the header system stats
  // and passed down to Dashboard panels (JobPanel, BuildLayoutPanel).
  const job = useJob(1000);

  useEffect(() => {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) setDark(true);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar dark={dark} onToggleDark={() => setDark((d) => !d)} />
      <SidebarInset className="flex flex-col min-h-0">
        <header className="flex items-center gap-2 border-b-2 border-border bg-background px-3 py-2 shrink-0">
          <SidebarTrigger />
          <div className="h-5 w-[2px] bg-border" />
          <RecordingStatusBanner />
          {job && (
            <div className="ml-auto flex items-center gap-4 text-[10px] font-mono opacity-60">
              <span>cpu {job.cpuTemp.toFixed(0)}°C</span>
              <span>gpu {job.gpuTemp.toFixed(0)}°C</span>
              <span>load {job.totalCpuLoad.toFixed(1)}%</span>
              <span>mem {job.selfUsedMemory}/{job.totalAvailableMemory} MB</span>
            </div>
          )}
        </header>
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard job={job} />} />
            <Route path="/recording" element={<Recording />} />
            <Route path="/builds" element={<Builds />} />
            <Route path="/builds/:buildId" element={<BuildCard />} />
            <Route path="/builds/:buildId/replay" element={<Replay />} />
            {/* legacy paths */}
            <Route path="/database" element={<Navigate to="/builds" replace />} />
            <Route path="/database/:buildId/replay" element={<Replay />} />
            <Route path="/profiles" element={<PrintProfiles />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/powder-tuning" element={<PowderTuning />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/mission" element={<MissionControl job={job} />} />
            <Route path="/labeling" element={<Labeling />} />
            <Route path="/datasets/:slug" element={<DatasetPage />} />
            <Route path="/datasets/telemetry/:buildId" element={<TelemetryBuildLab />} />
            <Route path="/services" element={<Services />} />
          </Routes>
        </main>
      </SidebarInset>
      {/* The right-docked agent sidebar is gone (2026-07-16): Mission
          Control's PanelConsole is the single agentic-system surface. */}
    </SidebarProvider>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <AppShell />
    </BrowserRouter>
  );
}
