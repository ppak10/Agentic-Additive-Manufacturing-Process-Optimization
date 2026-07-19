import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SESSION_RESULT, fmtHours } from "./Builds";

// Build card — everything known about one build: registry linkage, key
// profile parameters, telemetry summary (thermal tracking, layer timeline),
// ASTM outcomes, and any agent interventions. Mirrors the build_get MCP
// tool.

interface CardData {
  registry: {
    build_id: number;
    started_at: string;
    ended_at: string | null;
    inova_session_id: string | null;
    session_result: number | null;
    job_id: string | null;
    job_name: string | null;
    profile_name: string | null;
    print_date: string | null;
    has_astm: boolean;
    notes: string | null;
    phase: string | null;
  };
  summary: {
    source: string;
    duration_s: number;
    n_recoats: number;
    n_print_layers: number;
    layer_duration_s_median: number | null;
    laser_on_s: number;
    power_w_mean: number | null;
    power_w_max: number | null;
    temps: Record<string, { dev_mean: number; dev_std: number; current_max: number }>;
    layers: Array<{ recoat: number; t_s: number; duration_s: number; laser_on_s: number; print_bed_c: number | null }>;
  } | null;
  profile_key_params: Record<string, unknown> | null;
  objects: Array<{ name: string; instance_count: number }> | null;
  astm_outcomes: Array<{
    standard: string;
    batch_label: string | null;
    n: string;
    modulus_mpa_mean: string | null;
    modulus_mpa_std: string | null;
    peak_stress_mpa_mean: string | null;
    strain_at_break_mean: string | null;
  }>;
  agent_actions: Array<{
    ts: string;
    harness: string | null;
    tool: string;
    arguments: unknown;
    is_error: boolean;
  }>;
}

function LayerTimeline({ layers }: { layers: NonNullable<CardData["summary"]>["layers"] }) {
  if (!layers.length) return null;
  const w = 720;
  const h = 60;
  const maxDur = Math.max(...layers.map((l) => l.duration_s), 1);
  const step = w / layers.length;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-16">
      {layers.map((l, i) => {
        const barH = Math.max(1, (l.duration_s / maxDur) * (h - 4));
        return (
          <rect
            key={l.recoat}
            x={i * step}
            y={h - barH}
            width={Math.max(step - 0.5, 0.5)}
            height={barH}
            className={l.laser_on_s > 0 ? "fill-primary" : "fill-muted-foreground/40"}
          >
            <title>{`recoat ${l.recoat}: ${l.duration_s}s, laser ${l.laser_on_s}s${l.print_bed_c ? `, bed ${l.print_bed_c}°C` : ""}`}</title>
          </rect>
        );
      })}
    </svg>
  );
}

export function BuildCard() {
  const { buildId } = useParams();
  const [data, setData] = useState<CardData | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(`/api/registry/${buildId}/card`)
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json()).error ?? `HTTP ${r.status}`);
        return r.json() as Promise<CardData>;
      })
      .then((d) => !cancelled && setData(d))
      .catch((e) => !cancelled && setError(String(e.message ?? e)));
    return () => {
      cancelled = true;
    };
  }, [buildId]);

  if (error) {
    return <div className="p-4 text-sm opacity-70">{error}</div>;
  }
  if (!data) return <div className="p-4 text-sm opacity-60">loading…</div>;

  const { registry: reg, summary, profile_key_params, objects, astm_outcomes, agent_actions } = data;
  const res = reg.session_result != null ? SESSION_RESULT[reg.session_result] : null;

  return (
    <div className="p-4 grid gap-4">
      {/* identity + primary nav now live in the breadcrumb row and the build
          tabs (BuildLayout); this keeps just the at-a-glance status badges */}
      <div className="flex items-center gap-2 flex-wrap">
        {res && <Badge variant={res.variant}>{res.label}</Badge>}
        {!reg.ended_at && <Badge>live</Badge>}
        {reg.has_astm && <Badge variant="neutral">ASTM tested</Badge>}
      </div>

      <Card>
        <CardContent className="pt-4 grid gap-1 text-sm">
          <div><span className="opacity-60">job:</span> {reg.job_name ?? "—"}</div>
          <div><span className="opacity-60">profile:</span> {reg.profile_name ?? "—"}</div>
          <div>
            <span className="opacity-60">started:</span>{" "}
            {new Date(reg.started_at).toLocaleString()}
            {summary && <> · <span className="opacity-60">duration:</span> {fmtHours(summary.duration_s)}</>}
          </div>
          {reg.inova_session_id && (
            <div className="text-xs opacity-50">session {reg.inova_session_id}</div>
          )}
          {reg.notes && <div className="text-xs opacity-70">note: {reg.notes}</div>}
          {objects && objects.length > 0 && (
            <div className="text-xs opacity-70">
              objects: {objects.map((o) => `${o.name}×${o.instance_count}`).join(", ")}
            </div>
          )}
        </CardContent>
      </Card>

      {summary && (
        <Card>
          <CardHeader>
            <CardTitle>
              Telemetry — {summary.n_print_layers} print layers / {summary.n_recoats} recoats
              {summary.layer_duration_s_median != null && ` · median layer ${summary.layer_duration_s_median}s`}
              {` · laser ${Math.round(summary.laser_on_s / 60)} min`}
            </CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3">
            <LayerTimeline layers={summary.layers ?? []} />
            <div className="overflow-x-auto">
              <table className="text-xs w-full">
                <thead>
                  <tr className="text-left opacity-70 border-b border-border">
                    <th className="py-1 pr-3">sensor</th>
                    <th className="py-1 pr-3">tracking error (mean ± σ, °C)</th>
                    <th className="py-1 pr-3">max °C</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(summary.temps ?? {})
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([sensor, t]) => (
                      <tr key={sensor} className="border-b border-border/30">
                        <td className="py-0.5 pr-3">{sensor}</td>
                        <td className="py-0.5 pr-3">
                          {t.dev_mean > 0 ? "+" : ""}{t.dev_mean.toFixed(1)} ± {t.dev_std.toFixed(1)}
                        </td>
                        <td className="py-0.5 pr-3">{t.current_max.toFixed(0)}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {profile_key_params && (
        <Card>
          <CardHeader><CardTitle>Profile parameters</CardTitle></CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-x-6 gap-y-1 text-xs">
              {Object.entries(profile_key_params).map(([k, v]) => (
                <div key={k} className="flex justify-between gap-2 border-b border-border/20 py-0.5">
                  <span className="opacity-60">{k}</span>
                  <span className="font-heading">{v == null ? "—" : String(v)}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {astm_outcomes.length > 0 && (
        <Card>
          <CardHeader><CardTitle>ASTM outcomes</CardTitle></CardHeader>
          <CardContent>
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left opacity-70 border-b border-border">
                  <th className="py-1 pr-3">standard</th>
                  <th className="py-1 pr-3">batch</th>
                  <th className="py-1 pr-3">n</th>
                  <th className="py-1 pr-3">modulus (MPa)</th>
                  <th className="py-1 pr-3">peak stress (MPa)</th>
                  <th className="py-1 pr-3">strain @ break</th>
                </tr>
              </thead>
              <tbody>
                {astm_outcomes.map((a, i) => (
                  <tr key={i} className="border-b border-border/30">
                    <td className="py-0.5 pr-3">{a.standard}</td>
                    <td className="py-0.5 pr-3">{a.batch_label ?? "—"}</td>
                    <td className="py-0.5 pr-3">{a.n}</td>
                    <td className="py-0.5 pr-3">
                      {a.modulus_mpa_mean ?? "—"}
                      {a.modulus_mpa_std && ` ± ${a.modulus_mpa_std}`}
                    </td>
                    <td className="py-0.5 pr-3">{a.peak_stress_mpa_mean ?? "—"}</td>
                    <td className="py-0.5 pr-3">{a.strain_at_break_mean ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}

      {agent_actions.length > 0 && (
        <Card>
          <CardHeader><CardTitle>Agent interventions</CardTitle></CardHeader>
          <CardContent>
            <table className="text-xs w-full">
              <thead>
                <tr className="text-left opacity-70 border-b border-border">
                  <th className="py-1 pr-3">time</th>
                  <th className="py-1 pr-3">harness</th>
                  <th className="py-1 pr-3">tool</th>
                  <th className="py-1 pr-3">arguments</th>
                </tr>
              </thead>
              <tbody>
                {agent_actions.map((a, i) => (
                  <tr key={i} className={`border-b border-border/30 ${a.is_error ? "text-destructive" : ""}`}>
                    <td className="py-0.5 pr-3">{new Date(a.ts).toLocaleTimeString()}</td>
                    <td className="py-0.5 pr-3">{a.harness ?? "—"}</td>
                    <td className="py-0.5 pr-3">{a.tool}</td>
                    <td className="py-0.5 pr-3 font-mono">{JSON.stringify(a.arguments)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
