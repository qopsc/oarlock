import { Button } from "@/components/ui/button";

export function CredentialRecovery({
  problem,
  onRetry,
  onRemove,
}: {
  problem?: string | null;
  onRetry?: () => Promise<void>;
  onRemove?: () => Promise<void>;
}) {
  if (!problem) return null;
  return (
    <div role="alert" className="space-y-1 text-xs text-muted-foreground">
      <p>{problem}</p>
      <p>Replace the key below, or remove the stored entry.</p>
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={() => void onRetry?.()}>
          Retry
        </Button>
        <Button size="sm" variant="outline" onClick={() => void onRemove?.()}>
          Remove stored key
        </Button>
      </div>
    </div>
  );
}
