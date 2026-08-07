import React, { useEffect, useMemo, useState } from "react";
import { BrowserRouter, Routes, Route, Navigate, NavLink, useLocation } from "react-router-dom";
import {
  MessageSquare,
  ChevronDown,
  Refrigerator,
  Plus,
  FlaskConical,
  Settings,
  Sun,
  Moon,
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
import { BuildLayout } from "@/pages/BuildLayout";
import { Replay } from "@/pages/Replay";
import { PrintProfiles } from "@/pages/PrintProfiles";
import { Jobs } from "@/pages/Jobs";
import { AstmTests } from "@/pages/AstmTests";
import { ProcessMap } from "@/pages/ProcessMap";
import { Tasks } from "@/pages/Tasks";
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
import { ArtifactSplit, ArtifactProvider, useCurrentArtifacts, type Artifact } from "@/panels/ArtifactPanel";

// Mission Control was removed from the sidebar 2026-07-19 (route still lives
// at /mission); its top slot now holds the Research dropdown below.
// "Research" — collapsible dropdown group (same neobrutalism submenu pattern
// as Machine below). Rendered in Mission Control's old top slot.
const RESEARCH_ITEMS = [
  { to: "/tests", label: "Tests" },
  { to: "/research/process-map", label: "Process Map" },
  { to: "/research/material", label: "Material" },
] as const;

// "Machine" — collapsible dropdown group (neobrutalism sidebar submenu
// pattern: Collapsible + SidebarMenuSub), holding the printer-library
// pages. Rendered between Live and Tuning.
const MACHINE_ITEMS = [
  { to: "/jobs", label: "Jobs" },
  { to: "/profiles", label: "Print Profiles" },
  { to: "/builds", label: "Builds" },
  { to: "/tasks", label: "Tasks" },
] as const;

// ChatGPT-style recent-conversations list: the agent plane's history,
// one link per conversation (panel console, chats, headless runs), plus
// the full Sessions table as the tail item. "+ New conversation" is just
// a link — the draft page (/conversations/new) owns the picker, and no
// conversation record exists until the first message is sent.
function ConversationsNav() {
  const location = useLocation();
  const conversations = useConversations(12);
  return (
    <SidebarGroup className="border-b-0">
      <SidebarGroupLabel>Conversations</SidebarGroupLabel>
      <SidebarMenu>
        <SidebarMenuItem>
          <SidebarMenuButton
            asChild
            tooltip="New conversation"
            isActive={location.pathname === "/conversations/new"}
          >
            <NavLink to="/conversations/new">
              <Plus />
              <span>New conversation</span>
            </NavLink>
          </SidebarMenuButton>
        </SidebarMenuItem>
        {(conversations ?? []).map((c) => {
          const to = `/conversations/${c.id}`;
          return (
            <SidebarMenuItem key={c.id}>
              <SidebarMenuButton
                asChild
                tooltip={c.title ?? `conversation ${c.id}`}
                isActive={location.pathname === to}
              >
                <NavLink to={to} className={c.debug ? "opacity-50" : undefined}>
                  <MessageSquare />
                  <span className="truncate">
                    {c.title?.trim() || `${c.role} · ${c.harness} #${c.id}`}
                  </span>
                  {c.debug && (
                    <span className="ml-auto text-[9px] font-mono uppercase opacity-70">dbg</span>
                  )}
                </NavLink>
              </SidebarMenuButton>
            </SidebarMenuItem>
          );
        })}
      </SidebarMenu>
    </SidebarGroup>
  );
}

function ResearchNav() {
  const location = useLocation();
  const anyActive = RESEARCH_ITEMS.some((i) => location.pathname.startsWith(i.to));
  return (
    <SidebarGroup className="border-b-0">
      <SidebarMenu>
        <Collapsible defaultOpen={anyActive} className="group/collapsible" asChild>
          <SidebarMenuItem>
            <CollapsibleTrigger asChild>
              <SidebarMenuButton tooltip="Research" isActive={anyActive}>
                <FlaskConical />
                <span>Research</span>
                <ChevronDown className="ml-auto transition-transform group-data-[state=open]/collapsible:rotate-180" />
              </SidebarMenuButton>
            </CollapsibleTrigger>
            <CollapsibleContent>
              <SidebarMenuSub>
                {RESEARCH_ITEMS.map((item) => (
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
                <Refrigerator />
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

function AppSidebar({ dark, onToggleDark }: { dark: boolean; onToggleDark: () => void }) {
  const location = useLocation();

  return (
    <Sidebar collapsible="icon">
      <SidebarContent>
        {/* rendered explicitly — interleaving on group index broke when the
            group list shrank to one (the dropdown silently vanished) */}
        <ResearchNav />
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
          <SidebarMenuItem>
            <SidebarMenuButton
              onClick={onToggleDark}
              tooltip={dark ? "Light mode" : "Dark mode"}
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
  const location = useLocation();
  // Single useJob call for the whole app — used by the header system stats
  // and passed down to Dashboard panels (JobPanel, BuildLayoutPanel).
  const job = useJob(1000);

  // The artifact panel is rendered here, at the shell level, so it spans the
  // full main area (beside the breadcrumb row rather than clipped under it).
  // Pages publish their artifacts via useSetArtifacts; we render the one split.
  // The artifact panel is a CONVERSATION-page feature only — it never shows on
  // the jobs / profiles / builds / mission-control pages. The live build feed is
  // no longer a standalone global tab: it now rides inside the build artifact
  // (which renders live "build mission control" while its build is the active
  // print), so monitoring is deliberate — attach the build. Non-conversation
  // routes get an empty list → ArtifactSplit shows no panel and no reopen pull.
  const onConversationPage = location.pathname.startsWith("/conversations");
  const publishedArtifacts = useCurrentArtifacts();
  const artifacts = useMemo<Artifact[]>(
    () => (onConversationPage ? publishedArtifacts : []),
    [onConversationPage, publishedArtifacts],
  );
  // per-surface divider width (keying the split also resets its open/close
  // state when the surface type changes).
  const artifactStorageId = onConversationPage
    ? "conversation-artifact-split"
    : "artifact-split";

  useEffect(() => {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) setDark(true);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <SidebarProvider defaultOpen={true}>
      <AppSidebar dark={dark} onToggleDark={() => setDark((d) => !d)} />
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
        <main className="flex-1 min-h-0 flex flex-col">
          {/* artifact panel is hoisted here so it spans the whole main area,
              alongside the breadcrumb row — the breadcrumbs + routes are its
              left pane; key on storageId so switching surfaces remounts it */}
          <ArtifactSplit key={artifactStorageId} artifacts={artifacts} storageId={artifactStorageId}>
          <div className="h-full min-h-0 overflow-auto flex flex-col">
          {/* docs-style breadcrumb: top-left of the page content; pages can
              portal actions into the right end of the row (#breadcrumb-actions) */}
          <div className="px-4 py-3 shrink-0 flex items-center justify-between gap-2">
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
            {/* Tabbed build shell: stats (index) · replay · triage. Nested so
                the tab bar persists and :buildId flows to every tab. */}
            <Route path="/builds/:buildId" element={<BuildLayout />}>
              <Route index element={<BuildCard />} />
              <Route path="replay" element={<Replay />} />
              {/* Triage is scoped to a build (was the global /labeling page) */}
              <Route path="triage" element={<Labeling />} />
            </Route>
            {/* legacy paths */}
            <Route path="/database" element={<Navigate to="/builds" replace />} />
            <Route path="/database/:buildId/replay" element={<Replay />} />
            {/* selection is route-backed via ONE optional-param route (same
                pattern as /jobs/:id? — two routes would remount the page) */}
            <Route path="/profiles/:id?" element={<PrintProfiles />} />
            <Route path="/jobs/:id?" element={<Jobs />} />
            <Route path="/tasks/:id?" element={<Tasks />} />
            <Route path="/mission" element={<MissionControl job={job} />} />
            {/* Research — ASTM mechanical-test specimen browser */}
            <Route path="/tests" element={<AstmTests />} />
            {/* Research — mechanical outcomes across process-parameter space */}
            <Route path="/research/process-map" element={<ProcessMap />} />
            {/* Research — placeholder pages (2026-07-19) */}
            <Route
              path="/research/material"
              element={
                <div className="p-6">
                  <h1 className="text-2xl font-bold">Material</h1>
                  <p className="mt-2 text-muted-foreground">Coming soon.</p>
                </div>
              }
            />
            {/* legacy global triage path — now a per-build view under /builds */}
            <Route path="/labeling" element={<Navigate to="/builds" replace />} />
            <Route path="/conversations/:id" element={<ConversationPage />} />
            <Route path="/datasets/:slug" element={<DatasetPage />} />
            <Route path="/datasets/telemetry/:buildId" element={<TelemetryBuildLab />} />
            {/* the overview grid retired 2026-07-16 — per-service pages only */}
            <Route path="/services" element={<Navigate to="/settings" replace />} />
            <Route path="/services/:slug" element={<ServiceDetail />} />
            <Route path="/settings" element={<SettingsPage dark={dark} onToggleDark={() => setDark((d) => !d)} />} />
          </Routes>
          </div>
          </div>
          </ArtifactSplit>
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
      <ArtifactProvider>
        <AppShell />
      </ArtifactProvider>
    </BrowserRouter>
  );
}
