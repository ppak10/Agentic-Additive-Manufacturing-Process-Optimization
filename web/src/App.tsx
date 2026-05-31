import { useEffect, useState } from "react";
import { Moon, Sun, Cpu } from "lucide-react";
import { Button } from "@/components/ui/button";
import { StatusPanel } from "@/panels/StatusPanel";
import { CameraPanel } from "@/panels/CameraPanel";

export function App() {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    if (window.matchMedia("(prefers-color-scheme: dark)").matches) setDark(true);
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  return (
    <div className="h-full flex flex-col">
      <header className="flex items-center gap-3 border-b-2 border-border bg-background px-4 py-2">
        <Cpu className="size-5" />
        <h1 className="font-heading text-sm">Agentic SLS · Inova MK1</h1>
        <div className="ml-auto">
          <Button variant="neutral" size="icon" className="size-7" onClick={() => setDark((d) => !d)}>
            {dark ? <Sun className="h-3.5 w-3.5" /> : <Moon className="h-3.5 w-3.5" />}
          </Button>
        </div>
      </header>
      <main className="flex-1 overflow-auto">
        <CameraPanel />
        <StatusPanel />
      </main>
    </div>
  );
}
