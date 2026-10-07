import { expect, it } from 'bun:test';
import { validateToolInvocation } from '../ai/toolCallRunner';
import { requireMacroToolRegistryEntry } from '../../shared/macroToolRegistry';
import { assessNativeToolPolicy, type NativeToolPolicyInput } from './nativeToolPolicy';
import { documentFixture, registryFixture, json } from './conformanceFixtures';
import { decode, encode } from './exact';
import { INVOCATION_CAPABILITIES, type CapturedRegistry } from './registry';
function fixture(toolId: string, args: string) {
  const input: NativeToolPolicyInput = { invocationIdentity: 'system/epoch/activation/tool', toolId,
    bindingJson: encode({ contract: { identity: `macro/tool/${toolId}`, version: '1' }, implementation: { identity: 'macro/desktop', version: '1' } }),
    argumentsJson: json(args), mode: 'Implement', riskLevel: 'balanced', capturedRiskLevel: 'balanced', root: '/synthetic/project', allowedToolIds: [toolId] };
  const registry: CapturedRegistry = { ...registryFixture(documentFixture()), bindings: [{
    declarationJson: input.bindingJson, target: { kind: 'macro-tool', toolId }, argumentSchemaJson: encode(decode(JSON.stringify(requireMacroToolRegistryEntry(toolId).parameters))),
    resultConstraintJson: json('{"type":"string"}'), capabilities: INVOCATION_CAPABILITIES, verifiedRequirementsJson: [],
  }] };
  return { input, registry };
}
it('uses the actual Macro policy with no remembered grants', () => {
  const { input, registry } = fixture('write', '{"path":"file.txt","content":"9007199254740993"}');
  expect(assessNativeToolPolicy(input, registry).decision).toBe('allow');
  expect(assessNativeToolPolicy({ ...input, riskLevel: 'strict' }, registry).decision).toBe('ask');
  expect(assessNativeToolPolicy({ ...input, mode: 'Chat' }, registry).decision).toBe('deny');
  expect(assessNativeToolPolicy({ ...input, allowedToolIds: [] }, registry).decision).toBe('deny');
  expect(assessNativeToolPolicy(input, registry).input.argumentsJson).toBe(input.argumentsJson);
});
it.each(['balanced', 'strict', 'yolo'] as const)('terminal_run still asks under %s', riskLevel => {
  const { input, registry } = fixture('terminal_run', '{"session_id":"native-session","command":"echo synthetic"}');
  const result = assessNativeToolPolicy({ ...input, riskLevel }, registry);
  expect(result.decision).toBe('ask');
  expect(result.input.invocationIdentity).toBe(input.invocationIdentity);
});
it('rejects another binding, arguments outside the registry schema and outside-scope paths', () => {
  const { input, registry } = fixture('read', '{"path":"file.txt"}');
  expect(assessNativeToolPolicy(input, registry).decision).toBe('allow');
  expect(assessNativeToolPolicy({ ...input, bindingJson: json('{}') }, registry).code).toBe('CORRELATION');
  expect(assessNativeToolPolicy({ ...input, argumentsJson: json('{"path":false}') }, registry).code).toBe('INPUT_CONSTRAINT');
  expect(assessNativeToolPolicy({ ...input, argumentsJson: json('{"path":"/outside/file.txt"}') }, registry).decision).toBe('deny');
});

it('never broadens the captured policy when the current risk policy becomes permissive', () => {
  const { input, registry } = fixture('write', '{"path":"file.txt","content":"synthetic"}');
  expect(assessNativeToolPolicy({ ...input, capturedRiskLevel: 'strict', riskLevel: 'yolo' }, registry).decision).toBe('ask');
});

it.each([
  ['read', { path: '   ' }, true],
  ['delete', { path: '   ' }, true],
  ['edit', { path: 'blank.txt', old_text: '   ', new_text: 'replacement' }, true],
  ['write', { path: 'blank.txt', content: '' }, false],
  ['write', { path: 'blank.txt', content: '   ' }, false],
  ['edit', { path: 'blank.txt', old_text: ' literal ', new_text: '' }, false],
] as const)('matches ordinary Macro validation for %s %j', (toolId, args, invalid) => {
  const authored = JSON.stringify(args);
  const { input, registry } = fixture(toolId, authored);
  const ordinary = validateToolInvocation({ toolName: toolId, args,
    schema: requireMacroToolRegistryEntry(toolId).parameters, allowedTools: new Set([toolId]) });
  expect(ordinary?.kind === 'result' ? ordinary.errorKind === 'validation' : false).toBe(invalid);
  const native = assessNativeToolPolicy(input, registry);
  expect(native.code === 'INPUT_CONSTRAINT').toBe(invalid);
  if (invalid) expect(native.decision).toBe('deny');
  expect(native.input.argumentsJson).toBe(json(authored));
  expect(JSON.stringify(args)).toBe(authored);
});
