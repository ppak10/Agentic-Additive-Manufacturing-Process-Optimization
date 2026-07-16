import { useEffect, useState, type ReactNode } from "react";
import { Maximize2, Minimize2 } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { cn } from "@/lib/utils";

// Card that toggles between an in-grid tile and a fixed-position modal-style
// expanded view. The Card stays mounted across the transition so any hooks /
// canvas refs inside its children keep their state — no data-stream flicker.
//
// Usage:
//   <ExpandableCard title="Chamber" headerRight={<Tabs />}>
//     <img ... />
//   </ExpandableCard>
export function ExpandableCard({
  title,
  headerRight,
  children,
  contentClassName,
}: {
  title: ReactNode;
  headerRight?: ReactNode;
  children: ReactNode;
  contentClassName?: string;
}) {
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    // Prevent background scroll while modal is open.
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  return (
    <>
      {expanded && (
        <div
          className="fixed inset-0 z-40 bg-black/60"
          onClick={() => setExpanded(false)}
        />
      )}
      <Card
        className={cn(
          expanded &&
            "fixed inset-4 z-50 max-w-[min(96vw,1400px)] mx-auto overflow-auto",
        )}
      >
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <span>{title}</span>
            <div className="ml-auto flex items-center gap-1">
              {headerRight}
              <button
                onClick={() => setExpanded((v) => !v)}
                aria-label={expanded ? "collapse" : "expand"}
                title={expanded ? "collapse (Esc)" : "expand"}
                className="px-1.5 py-0.5 border-2 border-border rounded-base bg-secondary-background text-foreground shadow-shadow hover:translate-x-boxShadowX hover:translate-y-boxShadowY hover:shadow-none transition-all"
              >
                {expanded ? <Minimize2 className="size-3" /> : <Maximize2 className="size-3" />}
              </button>
            </div>
          </CardTitle>
        </CardHeader>
        <CardContent className={cn("grid gap-2", contentClassName)}>{children}</CardContent>
      </Card>
    </>
  );
}
