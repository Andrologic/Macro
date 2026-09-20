import type { handleArchitectToolCall } from './architectToolRuntime';

/** Dependencies are supplied by the caller before loading; the captured turn
 * must still own this call before the Architect runtime can acquire any IO. */
export async function handleDeferredArchitectToolCall(
  params: Parameters<typeof handleArchitectToolCall>[0],
  loadRuntime: () => Promise<{ handleArchitectToolCall: typeof handleArchitectToolCall }> = () => import('./architectToolRuntime'),
): ReturnType<typeof handleArchitectToolCall> {
  const runtime = await loadRuntime();
  if (params.turnContext && !params.turnContext.isCurrent()) {
    throw new Error('Tool execution aborted');
  }
  return runtime.handleArchitectToolCall(params);
}
