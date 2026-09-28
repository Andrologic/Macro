import type { ChatToolInvocationJournal } from '../services/chatToolDispatch';
import type { ToolInvocation } from '../types/generated/ipc';

/** Existing execution tests exercise their own policy; journal behavior has focused tests. */
export const allowChatToolInvocationJournal: ChatToolInvocationJournal = {
  record: async () => ({ is_new: true, invocation: {} as ToolInvocation }),
  complete: async () => ({} as ToolInvocation),
  markUnknown: async () => ({} as ToolInvocation),
};
