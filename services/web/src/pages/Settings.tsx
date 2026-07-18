import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { sonarEnabled, setSonarEnabled, sonarPing } from "@/lib/sonar";
import { Link } from "react-router-dom";
import { DATASETS } from "@/pages/Datasets";

// Settings: traditional centered layout — one card per section, each
// preference a ROW (name + description left, control right). Controls are
// the neobrutalism Switch/Label/Button components.

function SettingRow({
  label,
  description,
  htmlFor,
  children,
}: {
  label: string;
  description: string;
  htmlFor?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-6 py-4 border-b-2 border-border last:border-b-0 last:pb-0 first:pt-0">
      <div className="grid gap-0.5">
        <Label htmlFor={htmlFor} className="text-sm">
          {label}
        </Label>
        <span className="text-xs opacity-60">{description}</span>
      </div>
      {children}
    </div>
  );
}

export function SettingsPage({
  dark,
  onToggleDark,
}: {
  dark: boolean;
  onToggleDark: () => void;
}) {
  const [sonar, setSonar] = useState(sonarEnabled);
  const [notifPermission, setNotifPermission] = useState(
    () => ("Notification" in window ? Notification.permission : "unsupported"),
  );

  return (
    <div className="p-6">
      <div className="mx-auto max-w-xl flex flex-col gap-6">
        <h1 className="text-xl font-heading">Settings</h1>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Appearance</CardTitle>
          </CardHeader>
          <CardContent>
            <SettingRow
              label="Dark mode"
              description="Follows your system preference on first load."
              htmlFor="dark-mode"
            >
              <Switch id="dark-mode" checked={dark} onCheckedChange={onToggleDark} />
            </SettingRow>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Alerts</CardTitle>
          </CardHeader>
          <CardContent>
            <SettingRow
              label="Sonar ping"
              description="Audio ping when a defect alert fires or panel candidates await selection. Rate-limited to one per 30 s."
              htmlFor="sonar"
            >
              <Switch
                id="sonar"
                checked={sonar}
                onCheckedChange={(on) => {
                  setSonar(on);
                  setSonarEnabled(on);
                  if (on) sonarPing(0); // audible confirmation
                }}
              />
            </SettingRow>
            <SettingRow
              label="Browser notifications"
              description={
                notifPermission === "granted"
                  ? "Enabled — alerts reach you even when this tab is in the background."
                  : notifPermission === "denied"
                    ? "Blocked by the browser — re-enable it in site permissions."
                    : notifPermission === "unsupported"
                      ? "Not supported by this browser."
                      : "Ask the browser for permission to notify you outside this tab."
              }
            >
              <Button
                size="sm"
                variant={notifPermission === "granted" ? "neutral" : "default"}
                disabled={notifPermission !== "default"}
                onClick={() => {
                  void Notification.requestPermission().then((p) => setNotifPermission(p));
                }}
              >
                {notifPermission === "granted" ? "Enabled" : "Enable"}
              </Button>
            </SettingRow>
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Services</CardTitle>
          </CardHeader>
          <CardContent>
            {([
              ["recorder", "Recorder", "agentic-sls-recorder · :3000 — telemetry, frames, build lifecycle + recording health"],
              ["postgres", "Postgres", "agentic-sls-postgres · :5432 — the single query surface"],
              ["broker", "Agent broker", "agentic-sls-broker · :3100 — harness CLIs, chats, panel mode + auth"],
              ["defect", "Defect bridge", "agentic-sls-defect · :3200 — MAIL-10 model client, labels"],
              ["plugin", "Inova plugin", "printer · :5001 — telemetry stream + overrides"],
              ["firmware", "Firmware", "printer · :80 — camera, thermal, plotter, job status"],
            ] as const).map(([slug, name, description]) => (
              <SettingRow key={slug} label={name} description={description}>
                <Button asChild size="sm" variant="neutral">
                  <Link to={`/services/${slug}`}>Open</Link>
                </Button>
              </SettingRow>
            ))}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Datasets</CardTitle>
          </CardHeader>
          <CardContent>
            {DATASETS.map((d) => (
              <SettingRow
                key={d.slug}
                label={d.title}
                description={d.hf}
              >
                <Button asChild size="sm" variant="neutral">
                  <Link to={`/datasets/${d.slug}`}>Open</Link>
                </Button>
              </SettingRow>
            ))}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
