import type { ChatToolInvocationJournal } from './chatToolDispatch';
import { recordToolInvocation, completeToolInvocation, markToolInvocationUnknown } from './ipc/toolInvocations';
import { isRemoteServiceRuntime } from './serviceRuntime';
import { isTauriAvailable } from './ipc/runtime';

/** Desktop SQLite journal; remote execution keeps its own transport contract. */
export const chatToolInvocationJournal: ChatToolInvocationJournal = {
  // Match workspaceToolExecutor's actual transport choice. A Tauri window can
  // request remote services while still executing workspace tools via IPC.
  isRemoteRuntime: () => isRemoteServiceRuntime() && !isTauriAvailable(),
  record: recordToolInvocation,
  complete: completeToolInvocation,
  markUnknown: markToolInvocationUnknown,
};
