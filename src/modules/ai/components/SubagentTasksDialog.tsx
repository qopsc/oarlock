import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  cancelTask,
  initializeTasks,
  useSubagentTasks,
} from "../store/subagentTasks";
export default function SubagentTasksDialog({
  onClose,
}: {
  onClose: () => void;
}) {
  const tasks = useSubagentTasks((s) => s.tasks);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [attempt, setAttempt] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: attempt explicitly retries a failed native load.
  useEffect(() => {
    let live = true;
    setLoading(true);
    setError(null);
    void initializeTasks()
      .catch((e) => {
        if (live) setError(String(e));
      })
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [attempt]);
  const task = tasks.find((t) => t.id === selected) ?? tasks[0];
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        className="flex max-h-[80vh] flex-col sm:max-w-3xl"
        onPointerDown={(e) => e.stopPropagation()}
      >
        <DialogHeader>
          <DialogTitle>Subagent tasks</DialogTitle>
          <DialogDescription>
            Status and results remain here after chat deletion. The latest 32
            finished tasks are saved. Closing a task’s window interrupts its
            running subagents.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <div role="alert">
            <p>{error}</p>
            <Button onClick={() => setAttempt((a) => a + 1)}>Retry</Button>
          </div>
        ) : loading ? (
          <p role="status">Loading tasks…</p>
        ) : tasks.length === 0 ? (
          <p className="py-8 text-center text-muted-foreground">
            No subagents have run yet.
          </p>
        ) : (
          <div className="grid min-h-0 grid-cols-[minmax(120px,1fr)_2fr] gap-4 overflow-hidden">
            <nav
              className="flex flex-col gap-1 overflow-y-auto"
              aria-label="Subagent tasks"
            >
              {tasks.map((t) => (
                <button
                  type="button"
                  key={t.id}
                  aria-pressed={task?.id === t.id}
                  onClick={() => setSelected(t.id)}
                  className="rounded-md p-2 text-left hover:bg-muted aria-pressed:bg-muted"
                >
                  <span className="block truncate text-sm font-medium">
                    {t.title}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {t.status}
                  </span>
                </button>
              ))}
            </nav>
            {task && (
              <div className="min-w-0 overflow-y-auto">
                <div className="mb-3 flex items-center justify-between gap-2">
                  <h3 className="font-medium">{task.title}</h3>
                  {task.status === "running" && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        void cancelTask(task.id).catch((e) =>
                          toast.error("Could not stop subagent", {
                            description: String(e),
                          }),
                        );
                      }}
                    >
                      Stop
                    </Button>
                  )}
                </div>
                <p className="text-xs text-muted-foreground">
                  {task.status} · {task.modelId} ·{" "}
                  {new Date(task.startedAt).toLocaleString()}
                </p>
                <p className="mb-3 text-xs text-muted-foreground">
                  {task.inputTokens.toLocaleString()} input /{" "}
                  {task.outputTokens.toLocaleString()} output tokens
                </p>
                {task.step && (
                  <p role="status" className="mb-3 text-sm">
                    {task.step}
                  </p>
                )}
                <details className="mb-3 text-sm">
                  <summary>Task instructions</summary>
                  <p className="mt-2 whitespace-pre-wrap break-words">
                    {task.prompt}
                  </p>
                </details>
                {task.error && (
                  <p className="mb-3 whitespace-pre-wrap break-words text-sm text-destructive">
                    {task.error}
                  </p>
                )}
                {task.result && (
                  <div className="whitespace-pre-wrap break-words text-sm select-text">
                    {task.result}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
