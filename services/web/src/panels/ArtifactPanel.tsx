import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Link, useSearchParams } from "react-router-dom";
import { X, PanelRight } from "lucide-react";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { ResizablePanelGroup, ResizablePanel, ResizableHandle } from "@/components/ui/resizable";
import type { JobDetail } from "@/hooks/useJobs";
import { useJob } from "@/hooks/useJob";
import { useActiveBuild } from "@/hooks/useActiveBuild";
import { useJobInstances } from "@/hooks/useJobInstances";
import { JobBuild3D, PartViewer3D } from "@/panels/JobPreview3D";
import { JobPanel } from "@/panels/JobPanel";
import { ChamberThermalPane } from "@/pages/MissionControl";

// Artifact panel — the docked right-hand "things of concern", the printer-
// domain analogue of Claude's artifacts pane. A conversation accumulates
// artifacts over its lifetime (every job the agent touched, the live chamber
// while a print runs, profiles/reference docs later); they show up as TABS in
// one panel rather than a single slot. The caller publishes the current list
// via useSetArtifacts; ArtifactSplit (hoisted to the app shell) owns ordering,
// auto-switch, open/close, resize, and the reopen "pull".

// The discriminated artifact union. `job` = a stored-job 3D preview; `build` =
// a recorded print (links to its page); `profile` = a print profile's key
// fields; `chamber` = the live Mission Control feed (surfaced while a print
// runs). job/build/profile are pinned by the agent via the artifact_* MCP
// tools; chamber is added by the page while printing. The `type:id` key format
// is shared with the ?artifact= URL param and the MCP AGENTIC_FOCUS token.
export type Artifact =
  | { kind: "job"; jobId: string }
  | { kind: "build"; buildId: string }
  | { kind: "profile"; profileId: string }
  | { kind: "chamber" };

// Stable identity — the tab value, the ?artifact= URL token, and the key used
// for ordering / auto-switch. Must round-trip through artifactFromKey.
export function artifactKey(a: Artifact): string {
  switch (a.kind) {
    case "job":
      return `job:${a.jobId}`;
    case "build":
      return `build:${a.buildId}`;
    case "profile":
      return `profile:${a.profileId}`;
    case "chamber":
      return "chamber";
  }
}

// Parse a "type:id" token (URL param / MCP focus) back into an Artifact.
// Null for unknown tokens so a stale URL param is simply ignored.
export function artifactFromKey(key: string): Artifact | null {
  if (key === "chamber") return { kind: "chamber" };
  const i = key.indexOf(":");
  if (i < 0) return null;
  const id = key.slice(i + 1);
  switch (key.slice(0, i)) {
    case "job":
      return id ? { kind: "job", jobId: id } : null;
    case "build":
      return id ? { kind: "build", buildId: id } : null;
    case "profile":
      return id ? { kind: "profile", profileId: id } : null;
    default:
      return null;
  }
}

// Tab label. Jobs/profiles are disambiguated by a short id (the full name isn't
// known until the tab's body fetches it); builds show their numeric id.
function tabLabel(a: Artifact): string {
  switch (a.kind) {
    case "chamber":
      return "Mission Control";
    case "job":
      return `Job · ${a.jobId.slice(0, 4)}`;
    case "build":
      return `Build ${a.buildId}`;
    case "profile":
      return `Profile · ${a.profileId.slice(0, 4)}`;
  }
}

// ── app-shell wiring ────────────────────────────────────────────────────────
// The panel is hoisted to the app shell (App.tsx) so it spans the full main
// area — beside the breadcrumb row, not clipped under it. Pages don't render
// the panel; they PUBLISH their artifact list and the shell renders the one
// ArtifactSplit.
const ArtifactCtx = createContext<{
  artifacts: Artifact[];
  setArtifacts: (a: Artifact[]) => void;
}>({ artifacts: [], setArtifacts: () => {} });

export function ArtifactProvider({ children }: { children: ReactNode }) {
  const [artifacts, setArtifacts] = useState<Artifact[]>([]);
  return (
    <ArtifactCtx.Provider value={{ artifacts, setArtifacts }}>{children}</ArtifactCtx.Provider>
  );
}

// Shell reads the currently-published artifact list.
export function useCurrentArtifacts(): Artifact[] {
  return useContext(ArtifactCtx).artifacts;
}

// Page hook: publish the current artifact list while mounted; clear on unmount
// so a page that doesn't publish leaves the panel absent. Keyed on the list
// signature so a fresh array with the same members doesn't churn the context.
export function useSetArtifacts(artifacts: Artifact[]) {
  const { setArtifacts } = useContext(ArtifactCtx);
  const sig = artifacts.map(artifactKey).join("");
  useEffect(() => {
    setArtifacts(artifacts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig, setArtifacts]);
  useEffect(() => () => setArtifacts([]), [setArtifacts]);
}

// Read-only job preview: whole-build view stacked over the selected-part
// viewer, then the parts list (click a row to change the selected part).
function JobArtifact({ jobId }: { jobId: string }) {
  const { chamber, instances, unavailable } = useJobInstances(jobId);
  const [detail, setDetail] = useState<JobDetail | null>(null);
  const [notFound, setNotFound] = useState(false);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setNotFound(false);
    setSelectedHash(null);
    void (async () => {
      try {
        const r = await fetch(`/api/jobs/${encodeURIComponent(jobId)}`);
        if (cancelled) return;
        if (!r.ok) {
          setNotFound(true);
          return;
        }
        const d = (await r.json()) as JobDetail;
        if (cancelled) return;
        setDetail(d);
        setSelectedHash(d.objectFiles?.[0]?.hash ?? null);
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [jobId]);

  if (notFound) {
    return (
      <div className="text-xs opacity-60">
        Job <span className="font-mono">{jobId.slice(0, 8)}</span> is no longer on the printer.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-heading text-sm truncate" title={detail?.name}>
          {detail?.name ?? "loading job…"}
        </span>
        <span className="font-mono text-[10px] opacity-50">{jobId}</span>
      </div>

      {/* whole-build view */}
      <div className="h-56 border-2 border-border overflow-hidden">
        {unavailable ? (
          <div className="p-3 text-xs opacity-50">
            Build preview needs the updated Inova plugin (/jobs/&#123;id&#125;/instances).
          </div>
        ) : instances === null ? (
          <div className="p-3 text-xs opacity-50">loading build…</div>
        ) : instances.length === 0 ? (
          <div className="p-3 text-xs opacity-50">This job has no nested instances.</div>
        ) : (
          <JobBuild3D
            jobId={jobId}
            chamber={chamber}
            instances={instances}
            selectedHash={selectedHash}
            onSelectHash={setSelectedHash}
          />
        )}
      </div>

      {/* selected-part viewer */}
      <div className="h-48 border-2 border-border overflow-hidden">
        <PartViewer3D jobId={jobId} hash={selectedHash} />
      </div>

      {/* parts list — click a row to drive both viewers */}
      <div className="flex flex-col gap-1 text-xs">
        <div className="text-[10px] uppercase tracking-widest opacity-50">
          Parts ({detail?.objectFiles.length ?? 0})
        </div>
        {detail && detail.objectFiles.length > 0 ? (
          <div className="border-2 border-border divide-y-2 divide-border">
            {detail.objectFiles.map((f) => {
              const isSel = f.hash === selectedHash;
              return (
                <button
                  key={f.id}
                  onClick={() => setSelectedHash(f.hash)}
                  className={
                    "flex w-full items-center gap-2 px-2 py-1.5 text-left " +
                    (isSel
                      ? "bg-main text-main-foreground"
                      : "bg-background hover:bg-secondary-background")
                  }
                >
                  <span className="flex-1 truncate font-heading" title={f.name}>
                    {f.name}
                  </span>
                  <span className="text-[10px] opacity-70">
                    ×{instances?.filter((i) => i.hash === f.hash).length ?? "?"}
                  </span>
                  <span className="text-[10px] font-mono opacity-40">{f.hash?.slice(0, 8)}</span>
                </button>
              );
            })}
          </div>
        ) : detail ? (
          <div className="text-[10px] opacity-40">No mesh files attached.</div>
        ) : null}
      </div>
    </div>
  );
}

// Live Mission Control feed — mirrors the Mission Control page layout: the
// Job card (status + progress bar) on top, the chamber/thermal/defect pane
// filling the rest. `phase` (from the live job) drives the object overlays.
function ChamberArtifact() {
  const job = useJob(2000);
  return (
    <div className="h-full min-h-0 p-2 flex flex-col gap-2">
      {/* shrink-0 (not overflow-y-auto): the scroll wrapper clipped the Job
          card's bottom-right box shadow — the card is small and needs no
          scroll, so let the shadow render into the padding/gap */}
      <div className="shrink-0">
        <JobPanel job={job} />
      </div>
      <div className="flex-1 min-h-0 grid">
        <ChamberThermalPane phase={job?.phase ?? null} />
      </div>
    </div>
  );
}

// Recorded-build reference (a PAST build): a compact card that links to the
// build's page. Deliberately light — the build's own tabbed shell (stats/
// replay/triage) is the place to dig in; here we just confirm which is pinned.
function BuildArtifact({ buildId }: { buildId: string }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="font-heading text-sm">Build {buildId}</div>
      <Link
        to={`/builds/${buildId}`}
        className="inline-block w-fit border-2 border-border rounded-base bg-main text-main-foreground px-2 py-1 text-xs shadow-shadow hover:translate-x-0.5 hover:translate-y-0.5 transition-transform"
      >
        Open build page →
      </Link>
      <div className="text-[10px] font-mono opacity-50">
        Pinned to this conversation. Stats, replay, and triage live on the build page.
      </div>
    </div>
  );
}

// A build artifact is context-aware: while THIS build is the active print it is
// live "build mission control" (chamber/thermal/defect stream + job status,
// edge-to-edge); once the print ends it collapses to the static recorded
// summary. This is the merge of the old standalone chamber tab into the build
// artifact — monitoring is now deliberate (attach the build), not global.
function BuildArtifactBody({ buildId }: { buildId: string }) {
  const active = useActiveBuild();
  if (active.printing && String(active.buildId) === buildId) {
    return <ChamberArtifact />;
  }
  return (
    <div className="h-full overflow-y-auto p-3">
      <BuildArtifact buildId={buildId} />
    </div>
  );
}

// Print-profile reference: name + the fields that drive an experiment. Read
// from the same /api/profiles/:id endpoint the Print Profiles page uses
// (?merged=true resolves nulls that inherit from the system Default).
const PROFILE_FIELDS: [key: string, label: string, unit?: string][] = [
  ["material", "Material"],
  ["layerThickness", "Layer thickness", "µm"],
  ["recoaterPasses", "Recoater passes"],
  ["heatingTargetPowder", "Powder target", "°C"],
  ["heatingTargetPrint", "Print target", "°C"],
  ["totalEnergyDensityPercent", "Total energy density", "%"],
  ["laserFillEnergyDensity", "Fill energy density"],
  ["outlineCount", "Outline count"],
];

function ProfileArtifact({ profileId }: { profileId: string }) {
  const [profile, setProfile] = useState<Record<string, unknown> | null>(null);
  const [notFound, setNotFound] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setProfile(null);
    setNotFound(false);
    void (async () => {
      try {
        const r = await fetch(`/api/profiles/${encodeURIComponent(profileId)}?merged=true`);
        if (cancelled) return;
        if (!r.ok) return setNotFound(true);
        setProfile((await r.json()) as Record<string, unknown>);
      } catch {
        if (!cancelled) setNotFound(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  if (notFound) {
    return (
      <div className="text-xs opacity-60">
        Profile <span className="font-mono">{profileId.slice(0, 8)}</span> is no longer on the printer.
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <span className="font-heading text-sm truncate" title={String(profile?.name ?? "")}>
          {profile ? String(profile.name ?? "(unnamed profile)") : "loading profile…"}
        </span>
        <span className="font-mono text-[10px] opacity-50">{profileId}</span>
      </div>
      <Link
        to={`/profiles/${profileId}`}
        className="inline-block w-fit border-2 border-border rounded-base bg-main text-main-foreground px-2 py-1 text-xs shadow-shadow hover:translate-x-0.5 hover:translate-y-0.5 transition-transform"
      >
        Edit on Print Profiles →
      </Link>
      {profile && (
        <div className="border-2 border-border divide-y-2 divide-border text-xs">
          {PROFILE_FIELDS.map(([key, label, unit]) => {
            const v = profile[key];
            return (
              <div key={key} className="flex items-center gap-2 px-2 py-1.5">
                <span className="flex-1 opacity-60">{label}</span>
                <span className="font-mono">
                  {v == null || v === "" ? "—" : `${v}${unit ? ` ${unit}` : ""}`}
                </span>
              </div>
            );
          })}
        </div>
      )}
      <div className="text-[10px] font-mono opacity-40">
        Profile names can lie — these are the JSON field values, not the name.
      </div>
    </div>
  );
}

// Body for one artifact. The job/profile previews scroll with padding; the
// chamber feed and a LIVE build fill edge-to-edge (they manage their own
// layout); a past build shows a padded static summary (handled inside
// BuildArtifactBody).
function ArtifactBody({ artifact }: { artifact: Artifact }) {
  if (artifact.kind === "chamber") return <ChamberArtifact />;
  if (artifact.kind === "build") return <BuildArtifactBody key={artifact.buildId} buildId={artifact.buildId} />;
  return (
    <div className="h-full overflow-y-auto p-3">
      {artifact.kind === "job" ? (
        <JobArtifact key={artifact.jobId} jobId={artifact.jobId} />
      ) : (
        <ProfileArtifact key={artifact.profileId} profileId={artifact.profileId} />
      )}
    </div>
  );
}

// Pure renderer: the tab strip (one tab per artifact) + close, over the active
// artifact's body. Radix keeps only the active tab's content mounted, so the
// chamber's streams spin up only while its tab is showing.
function ArtifactTabs({
  artifacts,
  activeKey,
  onSelect,
  onClose,
}: {
  artifacts: Artifact[];
  activeKey: string | null;
  onSelect: (k: string) => void;
  onClose: () => void;
}) {
  // guard against a stale activeKey (e.g. its artifact just left the list)
  const value =
    activeKey && artifacts.some((a) => artifactKey(a) === activeKey)
      ? activeKey
      : artifacts[0]
        ? artifactKey(artifacts[0])
        : "";

  return (
    <div className="h-full min-h-0 flex flex-col bg-background">
      <Tabs value={value} onValueChange={onSelect} className="h-full min-h-0 flex flex-col">
        <div className="flex items-center gap-2 border-b-2 border-border px-2 py-1.5 shrink-0">
          <TabsList className="h-8 max-w-full overflow-x-auto p-0.5">
            {artifacts.map((a) => {
              const k = artifactKey(a);
              return (
                <TabsTrigger key={k} value={k} className="h-6 px-2 text-[11px] shrink-0">
                  {tabLabel(a)}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <button
            onClick={onClose}
            title="Close panel"
            className="ml-auto shrink-0 rounded-base p-1 opacity-60 hover:opacity-100 hover:bg-secondary-background"
          >
            <X className="size-4" />
          </button>
        </div>
        {artifacts.map((a) => {
          const k = artifactKey(a);
          return (
            <TabsContent key={k} value={k} className="mt-0 flex-1 min-h-0">
              <ArtifactBody artifact={a} />
            </TabsContent>
          );
        })}
      </Tabs>
    </div>
  );
}

// Reusable host: wraps a surface's main content and docks the tabbed artifact
// panel on the right. Keeps a stable first-seen tab order, auto-opens and
// selects a newly-appeared artifact, and offers an edge "pull" (with a count)
// to reopen after the user closes it. `storageId` keeps each surface's divider
// width independent.
export function ArtifactSplit({
  artifacts,
  storageId,
  children,
}: {
  artifacts: Artifact[];
  storageId: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [order, setOrder] = useState<string[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  // The active tab lives in the URL (?artifact=type:id) so it's deep-linkable
  // and — on the conversation page — readable as the "focus" sent with each
  // message (no per-click DB write). Other params preserved; replace: true
  // keeps tab-flipping out of the history stack.
  const [searchParams, setSearchParams] = useSearchParams();
  const activeKey = searchParams.get("artifact");
  const selectKey = useCallback(
    (k: string) => {
      setSearchParams(
        (prev) => {
          const next = new URLSearchParams(prev);
          next.set("artifact", k);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );
  const sig = artifacts.map(artifactKey).join("");

  useEffect(() => {
    const keys = artifacts.map(artifactKey);
    // maintain a stable first-seen order (returning ephemera keep their slot)
    setOrder((prev) => {
      let changed = false;
      const next = [...prev];
      for (const k of keys) if (!next.includes(k)) { next.push(k); changed = true; }
      return changed ? next : prev;
    });
    // auto-switch: a brand-new artifact opens the panel and takes focus
    const fresh = keys.filter((k) => !seenRef.current.has(k));
    fresh.forEach((k) => seenRef.current.add(k));
    if (fresh.length > 0) {
      selectKey(fresh[fresh.length - 1]!);
      setOpen(true);
    } else if ((!activeKey || !keys.includes(activeKey)) && keys.length > 0) {
      // active tab vanished (or none set) → fall back to the newest
      selectKey(keys[keys.length - 1]!);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sig]);

  // present artifacts in stable first-seen order
  const ordered = useMemo(() => {
    const byKey = new Map(artifacts.map((a) => [artifactKey(a), a] as const));
    const out: Artifact[] = [];
    const seen = new Set<string>();
    for (const k of order) {
      const a = byKey.get(k);
      if (a && !seen.has(k)) { out.push(a); seen.add(k); }
    }
    for (const a of artifacts) {
      const k = artifactKey(a);
      if (!seen.has(k)) { out.push(a); seen.add(k); }
    }
    return out;
  }, [artifacts, order]);

  const showPanel = open && ordered.length > 0;

  // IMPORTANT: children stay in the SAME left panel whether or not the artifact
  // panel is showing. Rendering children in different structures (fragment vs.
  // split) as the panel toggles remounts the whole page subtree — which, since
  // a page derives its artifacts from its own (reset) state, oscillates and
  // flashes. So the group + left panel are constant; only the handle + right
  // panel are conditional (stable id/order lets the library add/remove them).
  return (
    <ResizablePanelGroup
      direction="horizontal"
      autoSaveId={storageId}
      className="h-full min-h-0"
    >
      <ResizablePanel id="main" order={1} minSize={30} className="min-h-0 relative">
        {children}
        {!open && ordered.length > 0 && (
          <button
            onClick={() => setOpen(true)}
            title={`Open artifacts (${ordered.length})`}
            className="absolute top-1/2 right-0 -translate-y-1/2 z-20 flex flex-col items-center gap-1 rounded-l-base border-2 border-r-0 border-border bg-background px-1.5 py-2 shadow-shadow hover:bg-secondary-background"
          >
            <PanelRight className="size-4" />
            <span className="text-[10px] font-heading">{ordered.length}</span>
          </button>
        )}
      </ResizablePanel>
      {showPanel && (
        <>
          <ResizableHandle withHandle />
          <ResizablePanel id="artifact" order={2} minSize={25} defaultSize={42} className="min-h-0">
            <ArtifactTabs
              artifacts={ordered}
              activeKey={activeKey}
              onSelect={selectKey}
              onClose={() => setOpen(false)}
            />
          </ResizablePanel>
        </>
      )}
    </ResizablePanelGroup>
  );
}
