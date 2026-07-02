import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useRecoaterPasses } from "@/hooks/useRecoaterPasses";
import { useRecoaterPassesFull } from "@/hooks/useRecoaterPassesFull";
import { useLayerOverrides } from "@/hooks/useLayerOverrides";

// Panel for runtime overrides — values that mutate the print pipeline's
// LayerClientOptions on the fly. Effect applies from the NEXT layer onward
// (LayerClient reads the override at the start of each layer). Empty input
// clears the override, returning to the print profile's default.
//
// "Recoater stages" is the firmware's RecoaterPasses(Override) — labeled
// "stages" here because a pass is NOT a full sweep: with PowderBedDivision =
// Thickness, pass i feeds 1/N of the powder dose (partial travel + shake
// pause), and only the last pass recoats the full bed at layer height.
//
// "Full recoats" is the plugin's FullRecoatLayerClient override: each layer
// is expanded into N full-height recoats — one normal recoat plus N-1 repeat
// sweeps at the same bed height. The powder checkbox controls whether the
// repeat sweeps each feed a fresh full dose (short-feed compensation; the
// extra consumption is budgeted via the print profile's cap powder) or run
// dry (debris clearing). While it is active, the stages override is bypassed
// during the expanded sub-recoats (each is a single uninterrupted sweep).
//
// The remaining rows are the generic LayerClientOptions override knobs,
// driven by the plugin's field registry (/api/printing/layer-overrides) —
// labels/units below are the only frontend-side knowledge about them.

// Shared number-input row: local input state so typing feels responsive
// without firing a POST on every keystroke; committed on blur or Enter.
function OverrideNumberRow({
  id,
  label,
  value,
  placeholder,
  statusText,
  busy,
  disabled,
  error,
  onCommit,
  min = 1,
  max = 5,
  step = 1,
  integer = true,
  children,
}: {
  id: string;
  label: string;
  value: number | null;
  placeholder: string;
  statusText: string;
  busy: boolean;
  disabled?: boolean;
  error: string | null;
  onCommit: (n: number | null) => Promise<void>;
  min?: number;
  max?: number;
  step?: number;
  integer?: boolean;
  children?: React.ReactNode;
}) {
  const [inputValue, setInputValue] = useState<string>("");
  const [localError, setLocalError] = useState<string | null>(null);

  useEffect(() => {
    setInputValue(value === null ? "" : String(value));
  }, [value]);

  const commit = async () => {
    setLocalError(null);
    const trimmed = inputValue.trim();
    let target: number | null;
    if (trimmed === "") {
      target = null;
    } else {
      const n = Number(trimmed);
      const valid = integer ? Number.isInteger(n) : Number.isFinite(n);
      if (!valid || n < min || n > max) {
        setLocalError(
          `${integer ? "integer" : "number"} between ${min} and ${max} (or empty to clear)`,
        );
        return;
      }
      target = n;
    }
    if (target === value) return;
    try {
      await onCommit(target);
    } catch {
      // hook already surfaces `error`; nothing further to do
    }
  };

  return (
    <div className="grid grid-cols-[minmax(140px,auto)_1fr] items-center gap-3 text-xs">
      <label className="opacity-70" htmlFor={id}>
        {label}
      </label>
      <div className="flex items-center gap-2 flex-wrap">
        <input
          id={id}
          type="number"
          min={min}
          max={max}
          step={step}
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            setLocalError(null);
          }}
          onBlur={() => void commit()}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              void commit();
            }
          }}
          placeholder={placeholder}
          disabled={busy || disabled}
          className="border-2 border-border rounded-base px-2 py-1 bg-secondary-background text-foreground w-24 disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-main"
        />
        {children}
        <span className="text-[10px] opacity-60">{statusText}</span>
        {(localError || error) && (
          <span
            className="text-red-600 dark:text-red-400 text-[10px]"
            title={localError ?? error ?? ""}
          >
            {localError ?? error}
          </span>
        )}
      </div>
    </div>
  );
}

// Frontend-side presentation for the generic override fields. Anything the
// plugin reports that isn't listed falls back to its raw name.
const LAYER_OVERRIDE_META: Record<string, { label: string; unit?: string; step?: number }> = {
  recoaterPowderSpeedFactorOverride: { label: "Powder zone speed", unit: "×", step: 0.05 },
  recoaterPrintSpeedFactorOverride: { label: "Print bed speed", unit: "×", step: 0.05 },
  recoaterShakeFactorOverride: { label: "Recoater shake", unit: "×", step: 0.05 },
  recoaterShakeBackoffOverride: { label: "Shake backoff", unit: "pos", step: 1 },
  zMoveForce: { label: "Z clearance", unit: "µm", step: 50 },
  volumeFactorOverride: { label: "Powder volume", unit: "×", step: 0.05 },
  customSinteredVolumeFactorOverride: { label: "Sintered volume", unit: "×", step: 0.05 },
  midRecoatThicknessFactorOverride: { label: "Mid-recoat thickness", unit: "×", step: 0.1 },
  settleTemperatureDelayOverride: { label: "Settle delay", unit: "s", step: 1 },
  layerExtendDelayOverride: { label: "Layer extend delay", unit: "s", step: 1 },
};

export function OverridePanel() {
  const passes = useRecoaterPasses();
  const full = useRecoaterPassesFull();
  const overrides = useLayerOverrides();

  const passesStatus =
    passes.value === null
      ? passes.profileDefault !== null
        ? `profile default: ${passes.profileDefault}`
        : "using profile default"
      : `override active: ${passes.value}${
          passes.profileDefault !== null ? ` (profile default: ${passes.profileDefault})` : ""
        }`;

  const fullStatus =
    full.replacementActive === false
      ? "unavailable — LayerClient substitution not loaded on printer"
      : full.value === null || full.value === 1
        ? "off (single recoat per layer)"
        : `override active: ${full.value} full-height recoats (repeats ${full.powder ? "powdered" : "dry"})`;

  // recoaterPassesOverride has its own dedicated row above (with the
  // profile-default readout), so skip it in the generic list.
  const genericFields = overrides.fields.filter((f) => f.name !== "recoaterPassesOverride");

  return (
    <Card>
      <CardHeader>
        <CardTitle>Overrides</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-3">
        <OverrideNumberRow
          id="recoater-passes-input"
          label="Recoater stages"
          value={passes.value}
          placeholder={passes.profileDefault !== null ? String(passes.profileDefault) : "auto"}
          statusText={passesStatus}
          busy={passes.busy}
          error={passes.error}
          onCommit={passes.setValue}
        />
        <OverrideNumberRow
          id="recoater-passes-full-input"
          label="Full recoats"
          value={full.value}
          placeholder="off"
          statusText={fullStatus}
          busy={full.busy}
          disabled={full.replacementActive === false}
          error={full.error}
          onCommit={full.setValue}
        >
          <label className="flex items-center gap-1 text-[10px] opacity-70">
            <input
              type="checkbox"
              checked={full.powder}
              disabled={full.busy || full.replacementActive === false}
              onChange={(e) => void full.setValue(full.value, e.target.checked).catch(() => {})}
            />
            powder
          </label>
        </OverrideNumberRow>
        {genericFields.length > 0 && (
          <div className="text-[10px] uppercase tracking-wide opacity-40 pt-1">
            Firmware layer overrides
          </div>
        )}
        {genericFields.map((f) => {
          const meta = LAYER_OVERRIDE_META[f.name] ?? { label: f.name };
          const current = f.iOptionsMonitor;
          const statusText =
            f.savedState === null
              ? `firmware: ${current ?? "unset"}${meta.unit ? ` ${meta.unit}` : ""}`
              : `override active: ${f.savedState}${meta.unit ? ` ${meta.unit}` : ""}`;
          return (
            <OverrideNumberRow
              key={f.name}
              id={`layer-override-${f.name}`}
              label={meta.unit ? `${meta.label} (${meta.unit})` : meta.label}
              value={f.savedState}
              placeholder={current !== null ? String(current) : "unset"}
              statusText={statusText}
              busy={overrides.busy}
              disabled={overrides.available === false}
              error={overrides.error}
              onCommit={(n) => overrides.setFields({ [f.name]: n })}
              min={f.min}
              max={f.max}
              step={meta.step ?? (f.kind === "int" ? 1 : 0.05)}
              integer={f.kind === "int"}
            />
          );
        })}
        <div className="text-[10px] opacity-50">
          Stages split one recoat&apos;s powder delivery into N staged passes — each feeds 1/N
          of the dose; only the final pass levels the bed at full layer height. Full recoats
          instead run one normal recoat plus N−1 repeat sweeps at the same bed height (bypassing
          staging while active); with powder checked each repeat feeds a fresh full dose
          (short-feed compensation — budget extra cap powder in the profile), unchecked they run
          dry for clearing debris. Overrides apply from the next print layer onward.
        </div>
      </CardContent>
    </Card>
  );
}
