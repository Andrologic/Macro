import { requireMacroToolRegistryEntry } from '../../shared/macroToolRegistry';
import { validateToolArguments } from '../toolArgumentValidation';
import type { AppMode, ToolRiskLevel } from '../../types';
import { evaluateToolSecurity } from '../toolSecurityPolicy';
import type { ExactJsonText } from './contracts';
import { ConformanceError, decode, equal, fail, record } from './exact';
import { toDispatchValue } from './dispatchValues';
import { validateRegisteredArguments, type CapturedRegistry } from './registry';

/** Native supplies this envelope from the current project policy and exact
 * invocation. It is carried by an authenticated, single-use compiler ticket. */
export interface NativeToolPolicyInput {
  readonly invocationIdentity: string;
  readonly toolId: string;
  readonly bindingJson: ExactJsonText;
  readonly argumentsJson: ExactJsonText;
  readonly mode: AppMode;
  readonly riskLevel: ToolRiskLevel;
  readonly capturedRiskLevel: ToolRiskLevel;
  readonly root: string;
  readonly allowedToolIds: readonly string[];
}
export type NativeToolPolicyResult = {
  readonly input: NativeToolPolicyInput;
  readonly decision: 'allow' | 'ask' | 'deny';
  readonly summary: string;
  readonly detail: string | null;
  readonly code: string | null;
};
/** The shared Macro evaluator remains the policy implementation. No conversation
 * grants or UI provider/settings stores participate in this resident request. */
export function assessNativeToolPolicy(input: NativeToolPolicyInput, registry: CapturedRegistry): NativeToolPolicyResult {
  try {
    if (!input.invocationIdentity || !input.root || !['Implement', 'Chat', 'Architect'].includes(input.mode)
      || !['balanced', 'strict', 'yolo'].includes(input.riskLevel)
      || !['balanced', 'strict', 'yolo'].includes(input.capturedRiskLevel) || !input.allowedToolIds.includes(input.toolId)) {
      return fail('PERMISSION', '', 'Native invocation is outside its current policy.');
    }
    const binding = registry.bindings.filter(entry => equal(decode(entry.declarationJson), decode(input.bindingJson)));
    if (binding.length !== 1 || binding[0].target.kind !== 'macro-tool' || binding[0].target.toolId !== input.toolId) {
      return fail('CORRELATION', '', 'Policy binding differs from the captured adapter.');
    }
    validateRegisteredArguments(binding[0], input.argumentsJson);
    record(decode(input.argumentsJson));
    const args = toDispatchValue(input.argumentsJson);
    if (!args || Array.isArray(args) || typeof args !== 'object') return fail('INPUT_CONSTRAINT', '', 'Tool arguments must be an object.');
    if (validateToolArguments(args, requireMacroToolRegistryEntry(input.toolId).parameters).length) {
      return fail('INPUT_CONSTRAINT', '', 'Tool arguments fail Macro validation.');
    }
    const evaluation = evaluateToolSecurity(input.toolId, args, {
      mode: input.mode, riskLevel: input.riskLevel, workspacePath: input.root, defaultWorkspacePath: input.root, grants: [],
    });
    const captured = evaluateToolSecurity(input.toolId, args, {
      mode: input.mode, riskLevel: input.capturedRiskLevel, workspacePath: input.root, defaultWorkspacePath: input.root, grants: [],
    });
    const decision = [evaluation.decision, captured.decision].includes('deny') ? 'deny'
      : input.toolId.startsWith('terminal_') || [evaluation.decision, captured.decision].includes('ask') ? 'ask' : 'allow';
    return { input, decision,
      summary: evaluation.normalizedCall.summary, detail: evaluation.normalizedCall.detail ?? null,
      code: decision === 'deny' ? 'PERMISSION' : null };
  } catch (error) {
    if (!(error instanceof ConformanceError)) throw error;
    return { input, decision: 'deny', summary: 'Tool invocation is not authorized.', detail: null, code: error.code };
  }
}
