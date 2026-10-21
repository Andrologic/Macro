/** A read-only refresh loop. It never submits work and never overlaps reads. */
export function startWorkflowTaskMonitor(ports: {
  enabled(): boolean;
  refresh(): Promise<void>;
  schedule(callback: () => void): () => void;
  report?(error: unknown): void;
}): () => void {
  let stopped = false;
  let cancel: (() => void) | undefined;
  const tick = async () => {
    if (stopped) return;
    try { if (ports.enabled()) await ports.refresh(); }
    catch (error) { if (!stopped) ports.report?.(error); }
    finally { if (!stopped) cancel = ports.schedule(() => { void tick(); }); }
  };
  cancel = ports.schedule(() => { void tick(); });
  return () => { stopped = true; cancel?.(); };
}
