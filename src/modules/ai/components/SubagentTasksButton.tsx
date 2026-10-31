import { lazy, Suspense, useState } from "react";
import { Button } from "@/components/ui/button";
const Tasks = lazy(() => import("./SubagentTasksDialog"));
export function SubagentTasksButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        className="h-6 px-2 text-xs"
        onClick={() => setOpen(true)}
        title="Subagent status and results"
      >
        Tasks
      </Button>
      {open && (
        <Suspense fallback={null}>
          <Tasks onClose={() => setOpen(false)} />
        </Suspense>
      )}
    </>
  );
}
