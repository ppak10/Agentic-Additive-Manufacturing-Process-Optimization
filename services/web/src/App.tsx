import React, { useEffect, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import {
  Bot,
  MessageSquare,
  ChevronDown,
  Factory,
  Tag,
  Radar,
  Settings,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
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
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
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
import { ServiceDetail } from "@/pages/Services";
import { MissionControl } from "@/pages/MissionControl";
import { SettingsPage } from "@/pages/Settings";
import { DatasetPage } from "@/pages/Datasets";
import { TelemetryBuildLab } from "@/pages/TelemetryBuildLab";
import { Labeling } from "@/pages/Labeling";
import { ConversationPage } from "@/pages/Conversation";
import { useJob, type JobStatus } from "@/hooks/useJob";
import { useConversations } from "@/hooks/useConversations";
import { RecordingStatusBanner } from "@/components/RecordingStatusBanner";
import { Breadcrumbs } from "@/components/Breadcrumbs";

const NAV_GROUPS = [
  {
    label: "Live",
    items: [
      { to: "/mission", label: "Mission Control", icon: Radar, end: false },
      { to: "/labeling", label: "Triage", icon: Tag, end: false },
    ],
  },
] as const;

// "Machine" — collapsible dropdown group (neobrutalism sidebar submenu
// pattern: Collapsible + SidebarMenuSub), holding the printer-library
// pages. Rendered between Live and Tuning.
const MACHINE_ITEMS = [
  { to: "/builds", label: "Builds" },
  { to: "/profiles", label: "Profiles" },
  { to: "/jobs", label: "Jobs" },
  { to: "/powder-tuning", label: "Powder Tuning" },
] as const;

// ChatGPT-style recent-conversations list: the agent plane's history,
// one link per conversation (panel console, chats, headless runs), plus
// the full Sessions table as the tail item.
function ConversationsNav() {
  const location = useLocation();
  const conversations = useConversations(12);
  return (
    <SidebarGroup className="border-b-0">
      <SidebarGroupLabel>Conversations</SidebarGroupLabel>
      <SidebarMenu>
        {(conversations ?? []).map((c) => {
          const to = `/conversations/${c.id}`;
          return (
            <SidebarMenuItem key={c.id}>
              <SidebarMenuButton
                asChild
                tooltip={c.title ?? `conversation ${c.id}`}
                isActive={location.pathname === to}
              >
                <NavLink to={to}>
                  <MessageSquare />
                  <span className="truncate">
                    {c.title?.trim() || `${c.role} · ${c.harness} #${c.id}`}
                  </span>
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip="All sessions"
            isActive={location.pathname.startsWith("/agents")}
          >
            <NavLink to="/agents">
              <Bot />
              <span className="opacity-70">All sessions</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
      </SidebarMenu>
    </SidebarGroup>
  );
}

function MachineNav() {
  const location = useLocation();
  const anyActive = MACHINE_ITEMS.some((i) => location.pathname.startsWith(i.to));
  return (
    <SidebarGroup className="border-b-0">
      <SidebarMenu>
        <Collapsible defaultOpen={anyActive} className="group/collapsible" asChild>
          <SidebarMenuItem>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton tooltip="Machine" isActive={anyActive}>
                <Factory />
                <span>Machine</span>
                <ChevronDown className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-180" />
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {MACHINE_ITEMS.map((item) => (
                  <SidebarMenuSubItem key={item.to}>
                    <SidebarMenuSubButton
                      asChild
                      isActive={location.pathname.startsWith(item.to)}
                    >
                      <NavLink to={item.to}>{item.label}</NavLink>
                    </SidebarMenuSubButton>
                  </SidebarMenuSubItem>
                ))}
              </SidebarMenuSub>
            </CollapsibleContent>
          </SidebarMenuItem>
        </Collapsible>
      </SidebarMenu>
    </SidebarGroup>
  );
}

function AppSidebar() {
  const location = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        {NAV_GROUPS.map((group) => (
          <React.Fragment key={group.label}>
          <SidebarGroup className="border-b-0">
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
          </React.Fragment>
        ))}
        {/* rendered explicitly — interleaving on group index broke when the
            group list shrank to one (the dropdown silently vanished) */}
        <MachineNav />
        <ConversationsNav />
      </SidebarContent>

      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              tooltip="Settings"
              isActive={location.pathname.startsWith("/settings")}
            >
              <NavLink to="/settings">
                <Settings />
                <span>Settings</span>
              </NavLink>
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
      <AppSidebar />
      {/* h-svh caps the shell at the viewport so page-internal scroll areas
          (e.g. the Jobs data-table) engage instead of growing the window */}
      <SidebarInset className="flex flex-col min-h-0 h-svh">
        <header className="flex items-center gap-2 border-b-2 border-border bg-background px-3 py-2 shrink-0">
          <SidebarTrigger />
          {/* recording status lives top-right; the cpu/gpu/load/mem readout
              retired 2026-07-16 (it belongs on the firmware service page if
              anywhere) */}
          <div className="ml-auto">
            <RecordingStatusBanner />
          </div>
        </header>
        <main className="flex-1 min-h-0 overflow-auto flex flex-col">
          {/* docs-style breadcrumb: top-left of the page content; pages can
              portal actions into the right end of the row (#breadcrumb-actions) */}
          <div className="px-4 pt-3 shrink-0 flex items-center justify-between gap-2">
            <Breadcrumbs />
            <div id="breadcrumb-actions" className="flex items-center gap-2" />
          </div>
          <div className="flex-1 min-h-0">
          <Routes>
            {/* Feed content moved to /services/plugin (2026-07-16); Mission
                Control is the landing page */}
            <Route path="/" element={<Navigate to="/mission" replace />} />
            {/* legacy path — Recording page now lives under the recorder service */}
            <Route path="/recording" element={<Navigate to="/services/recorder" replace />} />
            <Route path="/builds" element={<Builds />} />
            <Route path="/builds/:buildId" element={<BuildCard />} />
            <Route path="/builds/:buildId/replay" element={<Replay />} />
            {/* legacy paths */}
            <Route path="/database" element={<Navigate to="/builds" replace />} />
            <Route path="/database/:buildId/replay" element={<Replay />} />
            <Route path="/profiles" element={<PrintProfiles />} />
            <Route path="/jobs/:id?" element={<Jobs />} />
            <Route path="/powder-tuning" element={<PowderTuning />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/mission" element={<MissionControl job={job} />} />
            <Route path="/labeling" element={<Labeling />} />
            <Route path="/conversations/:id" element={<ConversationPage />} />
            <Route path="/datasets/:slug" element={<DatasetPage />} />
            <Route path="/datasets/telemetry/:buildId" element={<TelemetryBuildLab />} />
            {/* the overview grid retired 2026-07-16 — per-service pages only */}
            <Route path="/services" element={<Navigate to="/settings" replace />} />
            <Route path="/services/:slug" element={<ServiceDetail />} />
            <Route path="/settings" element={<SettingsPage dark={dark} onToggleDark={() => setDark((d) => !d)} />} />
          </Routes>
          </div>
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
