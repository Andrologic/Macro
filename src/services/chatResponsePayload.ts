// Shared by response writers and recovery equivalence checks.
export function responseOptions(message: import('../types').ChatMessage) {
  return {
    turnId: message.turn_id, toolTraces: message.tool_traces, hiddenContext: message.hidden_context,
    providerInputItems: message.provider_input_items, providerTurnState: message.provider_turn_state,
    contextRefs: message.context_refs, completionReason: message.completion_reason,
    generationAttempts: message.generation_attempts,
  };
}
