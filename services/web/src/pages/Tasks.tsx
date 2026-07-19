import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2, Play, RefreshCw, XCircle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { pushNotify, requestNotifyPermission, sonarPing } from "@/lib/sonar";
import { useTasks, type TaskRow } from "@/hooks/useTasks";

// ── helpers ───────────────────────────────────────────────────────────────────

const inputCls =
  "border-2 border-border rounded-base px-2 py-1 bg-secondary-background text-foreground text-xs w-[110px] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-main";

const STATUS_CLS: Record<TaskRow["status"], string> = {
  pending: "opacity-70",
  running: "bg-main text-main-foreground",
  succeeded: "bg-green-500 text-black",
  failed: "bg-red-500 text-white",
  canceled: "opacity-50 line-through",
};

function StatusBadge({ status }: { status: TaskRow["status"] }) {
  return (
    <span className={cn("border-2 border-border rounded-base px-1.5 py-0.5 text-[10px] font-heading uppercase", STATUS_CLS[status])}>
      {status}
    </span>
  );
}

function fmtWhen(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
  } catch { return iso; }
}

function fmtDuration(t: TaskRow): string {
  if (!t.started_at) return "—";
  const end = t.ended_at ? new Date(t.ended_at).getTime() : Date.now();
  const s = Math.max(0, Math.round((end - new Date(t.started_at).getTime()) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

function describe(t: TaskRow): string {
  const b = t.args?.builds ?? t.args?.build_id ?? t.build_id;
  return b != null ? `${t.kind} · build ${b}` : t.kind;
}

// The #breadcrumb-actions slot lives in the app shell; resolve it after mount.
function BreadcrumbActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<Element | null>(null);
  useEffect(() => { setTarget(document.getElementById("breadcrumb-actions")); }, []);
  return target ? createPortal(children, target) : null;
}

// ── detail panel ──────────────────────────────────────────────────────────────

function DetailPanel({ task, onCancel }: { task: TaskRow; onCancel: (id: number) => Promise<void> }) {
  const [canceling, setCanceling] = useState(false);
  const logRef = useRef<HTMLPreElement | null>(null);
  useEffect(() => {
    // keep the log pinned to the bottom as it streams
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [task.log]);

  return (
    <div className="flex flex-col gap-3 h-full min-h-0">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm font-heading">{describe(task)}</span>
        <StatusBadge status={task.status} />
        {task.status === "pending" && (
          <Button
            size="sm"
            variant="neutral"
            className="ml-auto"
            disabled={canceling}
            onClick={async () => { setCanceling(true); try { await onCancel(task.id); } finally { setCanceling(false); } }}
          >
            {canceling ? <Loader2 className="size-3 animate-spin" /> : <XCircle className="size-3" />}
            Cancel
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-x-6 gap-y-1 text-[10px] opacity-70">
        <span>#{task.id}</span>
        <span>created {fmtWhen(task.created_at)}</span>
        <span>started {fmtWhen(task.started_at)}</span>
        <span>ended {fmtWhen(task.ended_at)}</span>
        <span>duration {fmtDuration(task)}</span>
      </div>

      {task.error && (
        <div className="text-xs text-red-600 dark:text-red-400 break-words">{task.error}</div>
      )}

      <div className="text-[10px] uppercase tracking-widest opacity-50">Log</div>
      <pre
        ref={logRef}
        className="flex-1 min-h-0 overflow-auto border-2 border-border rounded-base bg-secondary-background p-2 text-[11px] font-mono whitespace-pre-wrap"
      >
        {task.log?.trim() ? task.log : "(no output yet)"}
      </pre>
    </div>
  );
}

// ── main page ─────────────────────────────────────────────────────────────────

export function Tasks() {
  const { list, error, refresh, createTask, cancelTask } = useTasks();
  const { id } = useParams();
  const navigate = useNavigate();
  const selectedId = id ? Number(id) : null;
  const selected = list?.find((t) => t.id === selectedId) ?? null;

  // New-export control (Phase 1 wires the `export` job only).
  const [buildInput, setBuildInput] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const runExport = async () => {
    const builds = buildInput.trim();
    if (!builds) { setFormError("Enter a build id"); return; }
    setSubmitting(true);
    setFormError(null);
    requestNotifyPermission(); // user gesture — enables the done-notification
    try {
      const t = await createTask("export", { builds });
      navigate(`/tasks/${t.id}`);
      setBuildInput("");
    } catch (e) {
      setFormError((e as Error).message ?? String(e));
    } finally {
      setSubmitting(false);
    }
  };

  // Completion notification: ping + browser notify when a task newly reaches a
  // terminal state. Seed the seen-set on first load so we don't ping history.
  const seenRef = useRef<Set<number> | null>(null);
  useEffect(() => {
    if (!list) return;
    const terminal = list.filter((t) => t.status === "succeeded" || t.status === "failed");
    if (seenRef.current === null) {
      seenRef.current = new Set(terminal.map((t) => t.id));
      return;
    }
    for (const t of terminal) {
      if (!seenRef.current.has(t.id)) {
        seenRef.current.add(t.id);
        sonarPing();
        pushNotify(`Task ${t.status}`, describe(t));
      }
    }
  }, [list]);

  return (
    <div className="p-4 flex flex-col gap-4 h-full">
      <BreadcrumbActions>
        <div className="flex items-center gap-2">
          <input
            type="text"
            inputMode="numeric"
            placeholder="build id"
            value={buildInput}
            className={inputCls}
            disabled={submitting}
            onChange={(e) => setBuildInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void runExport(); }}
          />
          <Button size="sm" onClick={() => void runExport()} disabled={submitting}>
            {submitting ? <Loader2 className="size-3 animate-spin" /> : <Play className="size-3" />}
            Run export
          </Button>
          <Button variant="neutral" size="sm" title="Refresh" onClick={refresh}>
            <RefreshCw className="size-3" />
          </Button>
        </div>
      </BreadcrumbActions>

      {formError && <div className="text-xs text-red-600 dark:text-red-400">{formError}</div>}

      <div className="grid grid-cols-[420px_1fr] gap-4 flex-1 min-h-0">
        {/* task list */}
        <div className="flex flex-col min-h-0 gap-2">
          {error && <div className="text-xs text-red-600 dark:text-red-400">{error}</div>}
          {!list && !error && <div className="text-xs opacity-50">loading…</div>}
          {list?.length === 0 && <div className="text-xs opacity-50">No tasks yet — run one above.</div>}

          {list && list.length > 0 && (
            <div className="flex flex-col min-h-0 border-2 border-border [&>div]:min-h-0">
              <Table className="table-fixed border-0">
                <TableHeader className="sticky top-0 z-10">
                  <TableRow>
                    <TableHead className="h-8 px-2 text-xs font-heading">Task</TableHead>
                    <TableHead className="h-8 px-2 text-xs font-heading w-[90px]">Status</TableHead>
                    <TableHead className="h-8 px-2 text-xs font-heading w-[92px]">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {list.map((t) => (
                    <TableRow
                      key={t.id}
                      data-state={t.id === selectedId ? "selected" : undefined}
                      onClick={() => navigate(`/tasks/${t.id}`)}
                      className="cursor-pointer bg-background text-foreground hover:bg-secondary-background data-[state=selected]:bg-main data-[state=selected]:text-main-foreground"
                    >
                      <TableCell className="px-2 py-1.5 text-xs font-heading truncate" title={describe(t)}>
                        {describe(t)}
                      </TableCell>
                      <TableCell className="px-2 py-1.5">
                        <StatusBadge status={t.status} />
                      </TableCell>
                      <TableCell className="px-2 py-1.5 text-[10px] whitespace-nowrap">
                        {new Date(t.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </div>

        {/* detail */}
        <Card className="flex flex-col min-h-0">
          {!selected && (
            <CardHeader>
              <CardTitle>{selectedId ? "Loading…" : "Select a task"}</CardTitle>
            </CardHeader>
          )}
          <CardContent className="flex-1 min-h-0 overflow-hidden">
            {!selectedId && (
              <div className="text-xs opacity-50">Select a task from the list, or run one from the toolbar.</div>
            )}
            {selectedId && !selected && (
              <div className="text-xs opacity-50">Task #{selectedId} not found in the current list.</div>
            )}
            {selected && <DetailPanel task={selected} onCancel={cancelTask} />}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
