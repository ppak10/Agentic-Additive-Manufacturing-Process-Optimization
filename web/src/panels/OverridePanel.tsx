import { useEffect, useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { useRecoaterPasses } from "@/hooks/useRecoaterPasses";
import { useRecoaterPassesFull } from "@/hooks/useRecoaterPassesFull";

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
// is expanded into N complete recoats at 1/N layer thickness. While it is
// active, the stages override is bypassed during the expanded sub-recoats
// (each sub-recoat is a single uninterrupted sweep).

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
      if (!Number.isInteger(n) || n < 1 || n > 5) {
        setLocalError("integer between 1 and 5 (or empty to clear)");
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
          min={1}
          max={5}
          step={1}
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

export function OverridePanel() {
  const passes = useRecoaterPasses();
  const full = useRecoaterPassesFull();

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
        : `override active: ${full.value} full recoats at 1/${full.value} thickness`;

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
        />
        <div className="text-[10px] opacity-50">
          Stages split one recoat&apos;s powder delivery into N staged passes — each feeds 1/N
          of the dose; only the final pass levels the bed at full layer height. Full recoats
          instead run N complete recoats at 1/N layer thickness each (and bypass staging while
          active). Overrides apply from the next print layer onward.
        </div>
      </CardContent>
    </Card>
  );
}
