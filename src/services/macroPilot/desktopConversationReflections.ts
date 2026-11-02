import { getPilotReflectionMessage, type PilotReflectionMessageRead } from '../tauriIpc';
import { isBrowserRuntimeBridgeEnabled } from '../tauriRuntimeBridge';
import { projectAssistantReflections } from '../markdownRenderProjection';
import type { ContentConversationRef } from './contentProtocol';
import { REFLECTION_LIMITS, type ReflectionObservation, type ReflectionSource } from './conversationReflections';
import type { DesktopStorePorts } from './desktopStorePorts';
import { desktopPilotTasks } from './desktopTaskCatalog';
import { findPilotTask } from './taskIdentity';
import { stableJson } from './protocol';
import type { ChatMessage, ToolTrace } from '../../types';
const fail = (code: string): never => { throw new Error(code); };
const generation = async (identity: unknown): Promise<string> => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(stableJson(identity)))),b => b.toString(16).padStart(2,'0')).join('');
interface ReflectionOptions {
  instanceId: string; workspaceId: string; ports: DesktopStorePorts; signal: AbortSignal;
  readMessage?: (conversationId: string,messageId: string) => Promise<PilotReflectionMessageRead>;
}
/** Minimal native history or the mapped live assistant, bound to its runtime owner. */
export function desktopConversationReflections(options: ReflectionOptions): ReflectionSource {
  const { instanceId,workspaceId,ports,signal }=options;
  const readMessage=options.readMessage ?? getPilotReflectionMessage;
  const check = () => { if (signal.aborted) fail('unavailable'); };
  const validateTarget = async (ref: ContentConversationRef): Promise<void> => {
    check();
    if (ref.instance_id !== instanceId || ref.kind === 'implement' && ref.workspace_id !== workspaceId) return fail('not_found');
    const conversation=ports.chat().conversations.find(item => item.id === ref.conversation_id);
    if (!conversation) return fail('not_found');
    if (ref.kind === 'conversation') {
      if (conversation.scope_mode !== 'Chat' || conversation.task_id) return fail('not_found');
    } else {
      const task=findPilotTask(desktopPilotTasks(ports),ref.task_id);
      if (!task || conversation.scope_mode !== 'Implement' || conversation.task_id !== task.id || task.conversation_id !== conversation.id) return fail('not_found');
    }
  };
  const validateNativeTarget = (ref: ContentConversationRef,message: Extract<PilotReflectionMessageRead,{ state: 'ready' }>['message']) => {
    const conversation=ports.chat().conversations.find(item => item.id === ref.conversation_id);
    if (!conversation || message.conversation_scope_mode !== (ref.kind === 'conversation' ? 'Chat' : 'Implement') || message.conversation_task_id !== conversation.task_id) return fail('not_found');
  };
  const runtimeIdentity = (ref: ContentConversationRef,messageId: string) => {
    const runtime=ports.chat().conversationRuntimeById[ref.conversation_id];
    return runtime && !['idle','error'].includes(runtime.phase) && runtime.assistantMessageId === messageId && runtime.sessionId && runtime.turnId
      ? [runtime.sessionId,runtime.turnId,runtime.assistantMessageId] : null;
  };
  const activeMessage = (ref: ContentConversationRef,messageId: string): ChatMessage | null => {
    const chat=ports.chat();const index=chat.messageIndexById[messageId];
    const indexed=typeof index === 'number' ? chat.messages[index] : undefined;
    const message=indexed?.id === messageId ? indexed : chat.messagesByConversationId[ref.conversation_id]?.find(item => item.id === messageId);
    return message && message.role === 'assistant' && message.conversation_id === ref.conversation_id ? message : null;
  };
  const anchors = (traces: readonly ToolTrace[] | undefined): ToolTrace[] | undefined => traces?.map(trace => ({ tool_call_id: trace.tool_call_id,tool_name: trace.tool_name,status: trace.status,visible_offset: trace.visible_offset }));
  const unavailable = (state: 'withheld'|'unavailable'|'too_large',source: 'active'|'history',generationId: string|null,turnId: string|null): ReflectionObservation => ({ content: '',metadata: '',blocks: [],turnId,source,generationId,state });
  return {
    available: () => typeof window !== 'undefined' && !isBrowserRuntimeBridgeEnabled() && typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } }).__TAURI_INTERNALS__?.invoke === 'function',
    validateTarget,
    observe: async (ref,messageId) => {
      await validateTarget(ref);check();
      const identity=runtimeIdentity(ref,messageId);
      if (identity) {
        // Confirm durable message/turn/target even when its displayed content is
        // newer than SQLite. Deletion or a scope change invalidates live captures.
        const persisted=await readMessage(ref.conversation_id,messageId);check();await validateTarget(ref);
        if (persisted.state !== 'ready') return unavailable(persisted.state,'active',await generation(identity),String(identity[1]));
        if (persisted.message.id !== messageId || persisted.message.conversation_id !== ref.conversation_id || persisted.message.role !== 'assistant') return fail('not_found');
        validateNativeTarget(ref,persisted.message);
        if (persisted.message.turn_id !== identity[1]) return fail('stale_revision');
        const id=await generation(identity);check();const message=activeMessage(ref,messageId);
        if (!message || message.turn_id !== identity[1] || stableJson(runtimeIdentity(ref,messageId)) !== stableJson(identity)) return unavailable('unavailable','active',id,String(identity[1]));
        if (message.content.length > REFLECTION_LIMITS.sourceBytes || new TextEncoder().encode(message.content).length > REFLECTION_LIMITS.sourceBytes || (message.tool_traces?.length ?? 0) > REFLECTION_LIMITS.blocks) return unavailable('too_large','active',id,message.turn_id);
        if (message.tool_traces?.some(trace => typeof trace.tool_call_id !== 'string' || typeof trace.tool_name !== 'string' ||
          trace.tool_call_id.length > 256 || trace.tool_name.length > 256 || new TextEncoder().encode(trace.tool_call_id).length > 256 || new TextEncoder().encode(trace.tool_name).length > 256 ||
          trace.visible_offset != null && (typeof trace.visible_offset !== 'number' || !Number.isFinite(trace.visible_offset)))) return unavailable('withheld','active',id,message.turn_id);
        const traces=anchors(message.tool_traces);const metadata=stableJson(traces ?? []);
        if (metadata.length > 65536 || new TextEncoder().encode(metadata).length > 65536) return unavailable('too_large','active',id,message.turn_id);
        const projection=projectAssistantReflections({ content: message.content,isStreaming: true,toolTraces: traces,presentation: 'renderer' });
        return { content: message.content,metadata,blocks: projection.blocks,source: 'active',generationId: id,turnId: message.turn_id,
          ...(projection.state === 'withheld' ? { state: 'withheld' as const } : projection.state === 'source_too_large' ? { state: 'too_large' as const } : {}) };
      }
      const result=await readMessage(ref.conversation_id,messageId);check();await validateTarget(ref);check();
      if (runtimeIdentity(ref,messageId)) return fail('stale_revision');
      if (result.state !== 'ready') return unavailable(result.state,'history',null,null);
      const message=result.message;
      if (message.id !== messageId || message.conversation_id !== ref.conversation_id || message.role !== 'assistant') return fail('not_found');
      validateNativeTarget(ref,message);
      const traces=message.tool_traces;
      const projection=projectAssistantReflections({ content: message.content,isStreaming: false,toolTraces: traces,presentation: 'persisted',hasHiddenContext: message.has_hidden_context });
      const metadata=stableJson([message.has_hidden_context,traces]);
      return { content: message.content,metadata,blocks: projection.blocks,turnId: message.turn_id,source: 'history',generationId: null,
        ...(projection.state === 'withheld' ? { state: 'withheld' as const } : projection.state === 'source_too_large' ? { state: 'too_large' as const } : {}) };
    },
  };
}
