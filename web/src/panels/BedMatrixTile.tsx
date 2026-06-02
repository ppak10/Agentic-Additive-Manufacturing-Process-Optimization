import { useEffect, useMemo, useRef } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useBedMatrix } from "@/hooks/useBedMatrix";

// matplotlib plasma colormap (9 stops linearly interpolated) — perceptually
// uniform, deep-purple → magenta → orange → yellow.
const PLASMA: [number, number, number][] = [
  [13, 8, 135],
  [75, 3, 161],
  [125, 3, 167],
  [168, 34, 150],
  [203, 70, 121],
  [229, 107, 93],
  [248, 148, 65],
  [253, 195, 40],
  [240, 249, 33],
];

function plasma(t: number): [number, number, number] {
  if (t <= 0) return PLASMA[0]!;
  if (t >= 1) return PLASMA[PLASMA.length - 1]!;
  const x = t * (PLASMA.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = PLASMA[i]!;
  const b = PLASMA[i + 1]!;
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function renderToCanvas(canvas: HTMLCanvasElement, width: number, height: number, values: number[]) {
  // Internal resolution = exact matrix size; CSS scales it up with image-rendering: pixelated.
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }
  const range = max - min || 1;
  const img = ctx.createImageData(width, height);
  for (let i = 0; i < values.length; i++) {
    const t = (values[i]! - min) / range;
    const [r, g, b] = plasma(t);
    const o = i * 4;
    img.data[o] = r;
    img.data[o + 1] = g;
    img.data[o + 2] = b;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
}

export function BedMatrixTile() {
  const { frame, connected } = useBedMatrix();
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const stats = useMemo(() => {
    if (!frame) return null;
    const v = frame.data.values;
    let min = Infinity, max = -Infinity, sum = 0;
    for (const x of v) { if (x < min) min = x; if (x > max) max = x; sum += x; }
    return { min, max, avg: sum / v.length };
  }, [frame]);

  useEffect(() => {
    if (!frame || !canvasRef.current) return;
    renderToCanvas(canvasRef.current, frame.data.width, frame.data.height, frame.data.values);
  }, [frame]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span>Thermal · raw matrix</span>
          <Badge variant={connected ? "default" : "neutral"}>
            {connected ? `${frame ? `${frame.data.width}×${frame.data.height}` : "live"}` : "off"}
          </Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <canvas
          ref={canvasRef}
          className="block w-full border-2 border-border bg-background"
          style={{ imageRendering: "pixelated", aspectRatio: "32 / 24" }}
        />
        {stats && (
          <div className="grid grid-cols-3 gap-2 text-xs">
            <div className="flex justify-between">
              <span className="opacity-70">min</span>
              <span className="font-heading">{stats.min.toFixed(1)} °C</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">avg</span>
              <span className="font-heading">{stats.avg.toFixed(1)} °C</span>
            </div>
            <div className="flex justify-between">
              <span className="opacity-70">max</span>
              <span className="font-heading">{stats.max.toFixed(1)} °C</span>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
