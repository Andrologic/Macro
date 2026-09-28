import type { ChatToolInvocationJournal } from './chatToolDispatch';
import { recordToolInvocation, completeToolInvocation, markToolInvocationUnknown } from './ipc/toolInvocations';
import { isRemoteServiceRuntime } from './serviceRuntime';

/** The frontend-only kernel has no conversation invocation journal contract yet. */
export const chatToolInvocationJournal: ChatToolInvocationJournal = {
  record: (input) => {
    if (isRemoteServiceRuntime()) {
      throw new Error('The remote runtime has no durable conversation invocation journal.');
    }
    return recordToolInvocation(input);
  },
  complete: completeToolInvocation,
  markUnknown: markToolInvocationUnknown,
};
