import type { ChatToolExecutionPorts } from './chatToolExecutionContracts';
import type { createChatToolExecution as createRuntime } from './chatToolExecutionRuntime';

export type { ChatToolExecutionPorts } from './chatToolExecutionContracts';

/** The factory captures ports synchronously; execution starts only on a tool call.
 * The runtime's existing admission check runs after loading, before any effects. */
export function createChatToolExecution(
  ports: ChatToolExecutionPorts,
  loadRuntime: () => Promise<{ createChatToolExecution: typeof createRuntime }> = () => import('./chatToolExecutionRuntime'),
): ReturnType<typeof createRuntime> {
  return async (...args) => {
    const runtime = await loadRuntime();
    return runtime.createChatToolExecution(ports)(...args);
  };
}
