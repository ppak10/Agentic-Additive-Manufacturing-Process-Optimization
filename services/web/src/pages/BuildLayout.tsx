import { NavLink, Outlet, useLocation, useParams } from "react-router-dom";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

// Tabbed shell for a single build (/builds/:buildId). The tabs are
// route-backed — each is a NavLink into a nested route (index = stats), so
// deep-links and the breadcrumb trail keep working; the Tabs `value` only
// drives the active-styling. Replaces the per-page "← builds" back-nav +
// "Build N" header (identity now lives in the breadcrumb row).

const TABS = [
  { key: "stats", label: "Stats", segment: "" },
  { key: "replay", label: "Replay", segment: "replay" },
  { key: "triage", label: "Triage", segment: "triage" },
] as const;

export function BuildLayout() {
  const { buildId } = useParams<{ buildId: string }>();
  const { pathname } = useLocation();
  // /builds/:buildId/<segment> — index (stats) has no trailing segment
  const segment = pathname.split("/")[3] ?? "";
  const active = TABS.find((t) => t.segment === segment)?.key ?? "stats";

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="px-4 pt-3 shrink-0">
        <Tabs value={active}>
          <TabsList>
            {TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} asChild>
                <NavLink to={t.segment ? `/builds/${buildId}/${t.segment}` : `/builds/${buildId}`} end={t.segment === ""}>
                  {t.label}
                </NavLink>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </div>
      <div className="flex-1 min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
