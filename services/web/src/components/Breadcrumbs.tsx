import { Link, useLocation } from "react-router-dom";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb";
import { DATASETS } from "@/pages/Datasets";
import { SERVICE_TITLES, type ServiceSlug } from "@/pages/Services";

// Route-aware breadcrumbs for the app header. Crumbs mirror the sidebar's
// mental model (section / page / detail); intermediate crumbs link, the
// last is the current page.

interface Crumb {
  label: string;
  to?: string;
}

function crumbsFor(pathname: string, hint?: string): Crumb[] {
  const parts = pathname.split("/").filter(Boolean);
  if (parts.length === 0) return [{ label: "Mission Control" }];
  const [head, ...rest] = parts;
  switch (head) {
    case "mission":
      return [{ label: "Mission Control" }];
    case "recording":
      return [{ label: "Recording" }];
    case "builds": {
      const out: Crumb[] = [{ label: "Builds", to: "/builds" }];
      if (rest[0]) out.push({ label: `Build ${rest[0]}`, to: `/builds/${rest[0]}` });
      if (rest[1] === "replay") out.push({ label: "Replay" });
      if (rest[1] === "triage") out.push({ label: "Triage" });
      return out;
    }
    case "profiles": {
      if (!rest[0]) return [{ label: "Print Profiles" }];
      // profile names live on the printer — pages pass them via
      // location.state.breadcrumb (same pattern as jobs)
      return [
        { label: "Print Profiles", to: "/profiles" },
        { label: hint ?? `Profile ${rest[0].slice(0, 8)}` },
      ];
    }
    case "jobs": {
      if (!rest[0]) return [{ label: "Jobs" }];
      // job names live on the printer, not in the URL — pages pass them via
      // location.state.breadcrumb; fall back to a shortened id until it loads
      return [
        { label: "Jobs", to: "/jobs" },
        { label: hint ?? `Job ${rest[0].slice(0, 8)}` },
      ];
    }
    case "powder-tuning":
      return [{ label: "Powder Tuning" }];
    case "conversations":
      return [
        { label: "Conversations" },
        ...(rest[0]
          ? [{ label: rest[0] === "new" ? "New conversation" : `Conversation ${rest[0]}` }]
          : []),
      ];
    case "datasets": {
      // dataset pages live under Settings since the sidebar group moved
      // there (2026-07-16) — the crumb trail is the way back
      const out: Crumb[] = [{ label: "Settings", to: "/settings" }, { label: "Datasets" }];
      const slug = rest[0];
      if (slug) {
        const spec = DATASETS.find((d) => d.slug === slug);
        out.push({ label: spec?.title ?? slug, to: `/datasets/${slug}` });
      }
      if (slug === "telemetry" && rest[1]) out.push({ label: `Build ${rest[1]} lab` });
      return out;
    }
    case "services": {
      // no overview page — "Services" is a plain crumb, Settings is the way up
      const out: Crumb[] = [{ label: "Settings", to: "/settings" }, { label: "Services" }];
      if (rest[0]) out.push({ label: SERVICE_TITLES[rest[0] as ServiceSlug] ?? rest[0] });
      return out;
    }
    case "settings":
      return [{ label: "Settings" }];
    default:
      return [{ label: pathname }];
  }
}

export function Breadcrumbs() {
  const { pathname, state } = useLocation();
  const hint = (state as { breadcrumb?: string } | null)?.breadcrumb;
  const crumbs = crumbsFor(pathname, hint);
  return (
    <Breadcrumb>
      <BreadcrumbList>
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1;
          return (
            <BreadcrumbItem key={`${c.label}-${i}`}>
              {last || !c.to ? (
                <BreadcrumbPage className={last ? undefined : "opacity-60"}>
                  {c.label}
                </BreadcrumbPage>
              ) : (
                <BreadcrumbLink asChild>
                  <Link to={c.to}>{c.label}</Link>
                </BreadcrumbLink>
              )}
              {!last && <BreadcrumbSeparator />}
            </BreadcrumbItem>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}
