// Label + value + optional unit row. Extracted from JobPanel so SystemPanel
// (and any future panels with metric rows) can share the same look/spacing.
export function MetricRow({
  label,
  value,
  unit,
}: {
  label: string;
  value: string | number;
  unit?: string;
}) {
  return (
    <div className="flex justify-between text-xs">
      <span className="opacity-70">{label}</span>
      <span className="font-heading">
        {value}
        {unit ? <span className="opacity-60 ml-1">{unit}</span> : null}
      </span>
    </div>
  );
}
