import { providerHasCredentials } from '../../stores/useProviderStore';
import type { ContentModelCatalog } from './contentProtocol';
import type { DesktopStorePorts } from './desktopStorePorts';
import type { ConversationCaptures } from './conversationCaptures';
import { createDesktopActions } from './desktopActions';
import { stableJson } from './protocol';
import { controlledText } from './conversationText';
import type { InteractionSource, InteractionState } from './conversationInteractions';

const fail = (code: string): never => { throw new Error(code); };
const generation = async (value: unknown) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(stableJson(value)))), byte => byte.toString(16).padStart(2, '0')).join('');

/** Uses the same native actions and reservations as desktop UI. Reads do not
 * change selection, provider settings or questionnaire drafts. */
export function desktopConversationInteractions(instanceId: string, captures: ConversationCaptures, ports: DesktopStorePorts, signal: AbortSignal): InteractionSource {
  const actions = createDesktopActions(ports);
  const check = () => { if (signal.aborted) fail('unavailable'); };
  return {
    load: async (ref, policy) => {
      check();
      if (ref.instance_id !== instanceId) return fail('not_found');
      const catalog = await captures.refreshCatalogMetadata(true);
      if (!catalog.refs.some(candidate => stableJson(candidate) === stableJson(ref))) return fail('not_found');
      await ports.chat().ensureMessagesLoaded(ref.conversation_id);
      check();
      const chat = ports.chat();
      const conversation = chat.conversations.find(conversation => conversation.id === ref.conversation_id);
      if (!conversation) return fail('not_found');
      const runtime = chat.getConversationRuntime(ref.conversation_id);
      const active = chat.getActiveQuestionnaire(ref.conversation_id);
      const state: InteractionState = { question: null, generation_id: null, actions: [] };
      const busy = !['idle', 'error'].includes(runtime.phase);
      const exportText = (value: string, maximum: number) => {
        const text = controlledText(value, policy);
        if (!('text' in text) || text.content_state !== 'complete' || Array.from(text.text).length > maximum) return fail('content_unavailable');
        return text.text;
      };
      if (active?.mode === 'pending_reply') {
        if (active.totalSteps > 16) return fail('resource_limit');
        state.question = { assistant_message_id: active.assistantMessageId, steps: active.questionnaire.questions.map(step => ({
          step_id: step.id, prompt: exportText(step.prompt, 4000), choices: step.choices.map(choice => exportText(choice, 160)), free_text_allowed: true,
          ...(step.free_text_placeholder ? { free_text_placeholder: exportText(step.free_text_placeholder, 300) } : {}),
        })) };
        if (!busy && conversation.provider_id && conversation.model_id) state.actions.push('answer');
      }
      if (['preparing', 'streaming'].includes(runtime.phase) && runtime.sessionId) {
        state.generation_id = await generation([runtime.sessionId, runtime.turnId, runtime.assistantMessageId]);
        state.actions.push('stop');
      }
      const providers = ports.providers?.();
      if (providers) {
        const models: ContentModelCatalog['models'] = [];
        for (const provider of providers.providerConfigs) {
          if (!providerHasCredentials(provider) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provider.id)) continue;
          const name = controlledText(provider.name, policy);
          if (name.content_state !== 'complete' || !('text' in name) || !name.text || Array.from(name.text).length > 160) continue;
          for (const model of providers.modelsByProvider[provider.id] ?? []) {
            const label = controlledText(model.name || model.id, policy);
            const id = controlledText(model.id, policy);
            if (model.isEnabled === false || label.content_state !== 'complete' || !('text' in label) || !label.text || Array.from(label.text).length > 160 || id.content_state !== 'complete' || !('text' in id) || !id.text || Array.from(id.text).length > 256) continue;
            if (models.length >= 1000) break;
            models.push({ provider_id: provider.id, provider_name: name.text, model_id: id.text, model_name: label.text, reasoning_efforts: providers.getAvailableReasoningEfforts(provider.id, model.id).filter((effort): effort is NonNullable<ContentModelCatalog['selection']>['reasoning_effort'] & string => ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'].includes(effort)) });
          }
        }
        const selected = models.find(model => model.provider_id === conversation.provider_id && model.model_id === conversation.model_id && (conversation.reasoning_effort == null || model.reasoning_efforts.some(effort => effort === conversation.reasoning_effort)));
        state.model_catalog = { models, selection: selected ? { provider_id: selected.provider_id, model_id: selected.model_id, reasoning_effort: selected.reasoning_efforts.find(effort => effort === conversation.reasoning_effort) ?? null } : null };
        if (!busy && !active && !chat.pendingToolApprovalByConversationId[ref.conversation_id] && models.length) state.actions.push('select_model');
      }
      check();
      return { state, fingerprint: [conversation.scope_mode, conversation.task_id, conversation.provider_id, conversation.model_id, conversation.reasoning_effort,
        runtime.phase, runtime.sessionId, runtime.turnId, runtime.assistantMessageId, active?.mode, active?.questionnaire, active?.answersByStepId] };
    },
    execute: async (body, beforeEffect) => {
      check();
      const runtimeIdentity = () => {
        const runtime = ports.chat().getConversationRuntime(body.ref.conversation_id);
        return stableJson([runtime.sessionId, runtime.turnId, runtime.assistantMessageId]);
      };
      const expectedRuntime = body.action === 'stop' ? runtimeIdentity() : null;
      if (expectedRuntime && await generation(JSON.parse(expectedRuntime)) !== body.generation_id) return fail('stale_revision');
      const assertExecution = () => {
        check();
        if (expectedRuntime && runtimeIdentity() !== expectedRuntime) fail('stale_revision');
      };
      const guard = { assertCurrent: assertExecution, authorizeBeforeEffect: async (options?: { revision: 'expected' | 'consumed' }) => {
        assertExecution(); await beforeEffect(options?.revision === 'consumed'); assertExecution();
      } };
      if (body.action === 'stop') await actions.cancel(body.ref.conversation_id, guard);
      else if (body.action === 'select_model') {
        if (!body.selection) return fail('validation_failed');
        await actions.selectModel(body.ref.conversation_id, { providerId: body.selection.provider_id, modelId: body.selection.model_id, reasoningEffort: body.selection.reasoning_effort }, guard);
      } else {
        const active = ports.chat().getActiveQuestionnaire(body.ref.conversation_id);
        if (!active || active.mode !== 'pending_reply' || active.assistantMessageId !== body.assistant_message_id) return fail('stale_revision');
        await actions.answerDecision({ conversation_id: body.ref.conversation_id, assistant_message_id: body.assistant_message_id!, ...(active.taskId ? { task_id: active.taskId } : {}) }, body.answers!, guard);
      }
    },
  };
}
