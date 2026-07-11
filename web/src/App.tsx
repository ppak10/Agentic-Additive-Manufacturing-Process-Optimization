import { useEffect, useState } from "react";
import { HashRouter, Routes, Route, NavLink, Navigate } from "react-router-dom";
import { Moon, Sun, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { Dashboard } from "@/pages/Dashboard";
import { Recording } from "@/pages/Recording";
import { Database } from "@/pages/Database";
import { Replay } from "@/pages/Replay";
import { PrintProfiles } from "@/pages/PrintProfiles";
import { Jobs } from "@/pages/Jobs";
import { PowderTuning } from "@/pages/PowderTuning";
import { usePluginInfo, formatUptime } from "@/hooks/usePluginInfo";
import { RecordingStatusBanner } from "@/components/RecordingStatusBanner";

const NAV = [
  { to: "/", label: "Dashboard", end: true },
  { to: "/recording", label: "Recording", end: false },
  { to: "/database", label: "Database", end: false },
  { to: "/profiles", label: "Profiles", end: false },
  { to: "/jobs", label: "Jobs", end: false },
  { to: "/powder-tuning", label: "Powder Tuning", end: false },
] as const;

function NavTab({ to, label, end }: { to: string; label: string; end: boolean }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        cn(
          "px-3 py-1 text-xs font-heading border-2 border-border rounded-base transition-all",
          isActive
            ? "bg-main text-main-foreground shadow-shadow"
            : "bg-secondary-background text-foreground hover:translate-x-boxShadowX hover:translate-y-boxShadowY shadow-shadow hover:shadow-none",
        )
      }
    >
      {label}
    </NavLink>
  );
}

export function App() {
  const [dark, setDark] = useState(false);
  const info = usePluginInfo();

  useEffect(() => {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) setDark(true);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <HashRouter>
      <div className="h-full flex flex-col">
        <header className="flex items-center gap-3 border-b-2 border-border bg-background px-4 py-2">
          <Cpu className="size-5" />
          <h1 className="font-heading text-sm">Agentic SLS · Inova MK1</h1>
          <nav className="ml-4 flex gap-2">
            {NAV.map((n) => (
              <NavTab key={n.to} to={n.to} label={n.label} end={n.end} />
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3">
            <RecordingStatusBanner />
            {info && (
              <span className="text-[10px] opacity-50 hidden md:inline">
                plugin v{info.version} · up {formatUptime(info.uptimeSeconds)}
              </span>
            )}
            <Button variant="neutral" size="icon" className="size-7" onClick={() => setDark((d) => !d)}>
              {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
            </Button>
          </div>
        </header>
        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/recording" element={<Recording />} />
            <Route path="/database" element={<Database />} />
            <Route path="/database/:buildId/replay" element={<Replay />} />
            <Route path="/profiles" element={<PrintProfiles />} />
            <Route path="/jobs" element={<Jobs />} />
            <Route path="/powder-tuning" element={<PowderTuning />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
      </div>
    </HashRouter>
  );
}
