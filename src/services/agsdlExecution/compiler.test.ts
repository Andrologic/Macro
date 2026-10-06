import { describe, expect, it } from 'bun:test';
import { validateToolArguments } from '../toolArgumentValidation';
import { toDispatchValue } from './dispatchValues';
import { MACRO_TOOL_REGISTRY } from '../../shared/macroToolRegistry';
import { PRODUCT_RUNTIME_AVAILABLE, compilePlan, sourceDigest } from './compiler';
import { clone, decode, encode, equal, record } from './exact';
import { compileFixture, documentFixture, invocationFixture, id, json, registryFixture } from './conformanceFixtures';
import { argumentsSatisfy, requireExactRequirements, resolveBinding, validateRegisteredArguments, validateRegisteredResult, verifyArgumentSchema } from './registry';

const callDeclaration = () => decode('{"contract":{"identity":"synthetic/search","version":"1"},"implementation":{"identity":"macro/web-search","version":"1"},"effects":"none"}');
const searchSchema = () => json(JSON.stringify(MACRO_TOOL_REGISTRY.find(tool => tool.id === 'web_search')!.parameters));
function withCall() {
  const doc = documentFixture();
  record(doc.bindings).search = callDeclaration();
  record(record(record(doc.flow).steps).work).next = ['search'];
  record(record(doc.flow).steps).search = { type: 'call', binding: 'search', arguments: { query: { value: 'synthetic' } }, next: [] };
  const registry = registryFixture(doc);
  return { doc, registry: { ...registry, bindings: [...registry.bindings.filter(binding => record(decode(binding.declarationJson)).implementation !== undefined && encode(decode(binding.declarationJson)) !== encode(callDeclaration())), invocationFixture(encode(callDeclaration()), searchSchema())] } };
}
describe('versioned compiler and fail-closed runtime assessment', () => {
  it('compiles exact fixed configurations and serial routes while product availability stays false', async () => {
    const result = await compileFixture(documentFixture());
    expect(result.static.valid).toBe(true);
    expect(result.runtime.supported).toBe(true);
    expect(result.productRuntimeAvailable).toBe(false);
    expect(PRODUCT_RUNTIME_AVAILABLE).toBe(false);
    expect(result.plan!.steps[0].maxVisitsJson).toBe(json('1e20'));
    expect(result.plan!.steps[0].address).toEqual(['work']);
    expect(result.plan!.agents[0].settingsJson).toBe(json('{"budget":9007199254740993}'));
    expect(result.compiledPlanJson).toContain('macro-agsdl-compiled-plan/1');
    expect(result.plan!.agents[0].providerId).toBe('synthetic-provider');
  });
  it('separates valid documents with unsupported paths from invalid declarations', async () => {
    const valid = documentFixture(); delete record(record(valid.configurations).fixed).model;
    const unsupported = await compileFixture(valid);
    expect(unsupported.static.valid).toBe(true);
    expect(unsupported.runtime.supported).toBe(false);
    expect(unsupported.plan).toBeNull();
    const invalid = documentFixture(); record(record(invalid.agents).worker).configuration = 'missing';
    expect((await compileFixture(invalid)).static.valid).toBe(false);
    const bad = await compilePlan('{"id":1,"id":2}', { owner: { projectId: 'p', planId: 'p', branch: 'feature/p' }, revision: '1', sourceSha256: json('0') as never }, registryFixture(documentFixture()));
    expect(bad.static.diagnostics[0].code).toBe('PARSE');
  });
  it('checks the authored byte SHA and canonical metadata revision', async () => {
    const doc = documentFixture();
    const source = { owner: { projectId: 'p', planId: 'p', branch: 'feature/p' }, revision: '01', sourceSha256: '0' as never };
    expect((await compilePlan(encode(doc), source, registryFixture(doc))).runtime.diagnostics[0].code).toBe('CORRELATION');
  });
  it('captures source ownership, revision and SHA before the digest await', async () => {
    const doc = documentFixture(), authoredSource = encode(doc);
    const source = { owner: { projectId: 'synthetic-project', planId: 'synthetic-plan', branch: 'feature/original' }, revision: '7', sourceSha256: id<'sha256'>(await sourceDigest(authoredSource)) };
    const captured = clone(source);
    const pending = compilePlan(authoredSource, source, registryFixture(doc));
    source.owner.projectId = 'changed-project';
    source.owner.planId = 'changed-plan';
    source.owner.branch = 'feature/changed-during-compile';
    source.revision = 'not-canonical';
    source.sourceSha256 = id<'sha256'>('invalid');
    const result = await pending;
    expect(result.runtime.supported).toBe(true);
    expect(result.runtime.source).toEqual(captured);
    expect(result.plan!.source).toEqual(captured);
    expect(equal(record(decode(result.compiledPlanJson!)).source, captured)).toBe(true);
    expect(result.plan!.source.sourceSha256).toBe(id<'sha256'>(await sourceDigest(authoredSource)));
    expect(source.revision).toBe('not-canonical');
    expect(result.plan!.documentJson).toBe(authoredSource);
  });
  it('does not replace a mismatched captured SHA with a later caller mutation', async () => {
    const doc = documentFixture(), authoredSource = encode(doc);
    const validSha = id<'sha256'>(await sourceDigest(authoredSource));
    const source = { owner: { projectId: 'p', planId: 'p', branch: 'feature/p' }, revision: '7', sourceSha256: id<'sha256'>('f'.repeat(64)) };
    const pending = compilePlan(authoredSource, source, registryFixture(doc));
    source.sourceSha256 = validSha;
    const result = await pending;
    expect(result.runtime.supported).toBe(false);
    expect(result.runtime.diagnostics[0].code).toBe('CORRELATION');
    expect(result.runtime.source?.sourceSha256).toBe(id<'sha256'>('f'.repeat(64)));
    expect(result.plan).toBeNull();
  });
  it('requires a unique native model and complete verified configuration', async () => {
    const doc = documentFixture(), registry = registryFixture(doc);
    for (const changed of [{ ...registry, models: [] }, { ...registry, configurations: [] }, { ...registry, models: [...registry.models, ...registry.models] }]) expect((await compileFixture(doc, changed)).runtime.supported).toBe(false);
    const changed = documentFixture(); record(record(changed.configurations).fixed).settings = { other: 'changed' };
    expect((await compileFixture(changed, registry)).runtime.supported).toBe(false);
  });
  it('does not promote declared claims or binding requirements to end-to-end configuration proof', async () => {
    const doc = documentFixture();
    const requirement = decode('{"contract":{"identity":"synthetic/continuity","version":"1"},"parameters":{}}');
    record(record(doc.configurations).fixed).requires = [requirement];
    record(record(doc.configurations).fixed).claims = [{ requirement, status: 'supported', evidence: 'a'.repeat(64) }];
    const registry = registryFixture(doc);
    const bindingProof = { ...registry, bindings: registry.bindings.map(binding => ({ ...binding, verifiedRequirementsJson: [encode(requirement)] })) };
    expect((await compileFixture(doc, bindingProof)).runtime.supported).toBe(false);
    expect((await compileFixture(doc, { ...registry, configurations: registry.configurations.map(config => ({ ...config, verifiedRequirementsJson: [encode(requirement)] })) })).runtime.supported).toBe(true);
  });
  it('rejects dynamic configs, fan-out, URI and unsupported media before effects', async () => {
    const dynamic = documentFixture(); record(record(dynamic.agents).worker).configuration = { select: { value: 'fixed' }, cases: { fixed: 'fixed' } };
    const fanout = documentFixture();
    record(record(record(fanout.flow).steps).work).next = ['left', 'right'];
    Object.assign(record(record(fanout.flow).steps), { left: { type: 'agent', agent: 'worker' }, right: { type: 'agent', agent: 'worker' } });
    const uri = documentFixture(); uri.content = { unavailable: { uri: 'file:///workspace/source' } };
    const media = documentFixture(); record(record(media.agents).worker).interface = { inputMediaTypes: ['image/png'] };
    for (const doc of [dynamic, fanout, uri, media]) {
      const result = await compileFixture(doc);
      expect(result.static.valid).toBe(true);
      expect(result.runtime.supported).toBe(false);
      expect(result.compiledPlanJson).toBeNull();
    }
  });
  it('does not copy secret-bearing settings into captures or diagnostics', async () => {
    const doc = documentFixture(); record(record(doc.configurations).fixed).settings = { apiKey: 'synthetic-sensitive-value' };
    const result = await compileFixture(doc);
    expect(result.static.valid).toBe(true);
    expect(result.runtime.supported).toBe(false);
    expect(result.plan).toBeNull();
    expect(JSON.stringify(result)).not.toContain('synthetic-sensitive-value');
  });
  it('accepts public schema properties, resource names and literal data named like credentials', async () => {
    for (const name of ['password', 'authorization', 'credentials']) {
      const doc = documentFixture();
      const agent = record(record(doc.agents).worker);
      agent.interface = { results: { report: { mediaTypes: ['application/json'], valueSchema: { type: 'object', properties: { [name]: { type: 'string' } }, required: [name] } } } };
      agent.resources = { [name]: { value: { [name]: 'Public documentation example' }, mediaType: 'application/json' } };
      const result = await compileFixture(doc);
      expect(result.static.valid).toBe(true);
      expect(result.runtime.supported).toBe(true);
      expect(result.plan!.documentJson).toBe(encode(doc));
      expect(result.plan!.agents[0].configurationJson).toContain(`"${name}"`);
    }
  });
  it('accepts declared public output names such as authorization', async () => {
    const doc = documentFixture();
    record(record(doc.agents).worker).interface = { results: { authorization: { mediaTypes: ['application/json'] } } };
    const result = await compileFixture(doc);
    expect(result.static.valid).toBe(true);
    expect(result.runtime.supported).toBe(true);
    expect(result.plan!.steps[0].publicationContractJson).toContain('"authorization"');
  });
  it('still blocks credential fields in binding and effective native settings without leaking their values', async () => {
    const doc = documentFixture();
    record(record(doc.bindings).engine).settings = { nested: { credentials: { apiKey: 'synthetic-binding-secret' } } };
    const authored = await compileFixture(doc);
    expect(authored.static.valid).toBe(true);
    expect(authored.runtime.supported).toBe(false);
    expect(authored.plan).toBeNull();
    expect(JSON.stringify(authored)).not.toContain('synthetic-binding-secret');
    expect(authored.runtime.diagnostics[0].pointer).toBe('/bindings/engine/settings/nested/credentials');
    const plain = documentFixture(), registry = registryFixture(plain);
    const effective = await compileFixture(plain, { ...registry, configurations: registry.configurations.map(configuration => ({ ...configuration, effectiveSettingsJson: json('{"apiKey":"synthetic-native-secret"}') })) });
    expect(effective.runtime.supported).toBe(false);
    expect(effective.plan).toBeNull();
    expect(JSON.stringify(effective)).not.toContain('synthetic-native-secret');
  });
  it('uses real Macro tool schemas and refuses unknown targets or schema mutations', async () => {
    const { doc, registry } = withCall();
    expect((await compileFixture(doc, registry)).runtime.supported).toBe(true);
    const altered = { ...registry, bindings: registry.bindings.map(binding => binding.target.kind === 'macro-tool' ? { ...binding, argumentSchemaJson: json('{}') } : binding) };
    expect((await compileFixture(doc, altered)).runtime.supported).toBe(false);
    const unknown = { ...registry, bindings: registry.bindings.map(binding => binding.target.kind === 'macro-tool' ? { ...binding, target: { kind: 'macro-tool' as const, toolId: 'unknown' } } : binding) };
    expect((await compileFixture(doc, unknown)).runtime.supported).toBe(false);
  });
  it('checks graphless named output support and preserves its explicit publication contract', async () => {
    const doc = documentFixture(); delete doc.flow;
    record(record(doc.agents).worker).interface = { results: { report: { mediaTypes: ['application/json'] } } };
    const registry = registryFixture(doc);
    const result = await compileFixture(doc, registry);
    expect(result.runtime.supported).toBe(true);
    expect(result.plan!.entry).toBeNull();
    expect(record(decode(result.plan!.graphlessPublicationContracts.worker!)).step).toBeNull();
    expect((await compileFixture(doc, { ...registry, bindings: registry.bindings.map(entry => ({ ...entry, capabilities: entry.capabilities.filter(capability => capability !== 'typed-publication') })) })).runtime.supported).toBe(false);
  });
  it('pins contract, implementation, settings, effects and full requirements exactly', () => {
    const { doc, registry } = withCall();
    expect(resolveBinding(doc, 'search', registry, 'call').target.kind).toBe('macro-tool');
    for (const field of ['contract', 'implementation', 'settings', 'effects']) {
      const changed = documentFixture(); changed.bindings = decode(encode(record(doc.bindings)));
      record(record(changed.bindings).search)[field] = field === 'effects' ? 'external' : { identity: 'changed', version: '2' };
      expect(() => resolveBinding(changed, 'search', registry, 'call')).toThrow('complete');
    }
    const absent = decode('{"contract":{"identity":"r","version":"1"}}');
    expect(() => requireExactRequirements([absent], [json('{"contract":{"identity":"r","version":"1"},"parameters":{}}')])).toThrow('complete requirement');
    expect(() => requireExactRequirements([absent], [json('{"contract":{"identity":"r","version":"2"}}')])).toThrow();
  });
  it('requires exact captured MCP server identity, descriptor, schema and proven permissions', () => {
    const doc = documentFixture(); record(doc.bindings).search = callDeclaration();
    const registry = registryFixture(doc), descriptor = { id: 'mcp/search', serverId: 'server-one', name: 'search', inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'], additionalProperties: false } };
    const entry = { ...invocationFixture(encode(callDeclaration()), json(JSON.stringify(descriptor.inputSchema))), target: { kind: 'mcp-tool' as const, serverId: descriptor.serverId, toolId: descriptor.id, descriptorJson: json(JSON.stringify(descriptor)) } };
    const trusted = { ...registry, bindings: [entry], mcpTools: [descriptor] };
    expect(resolveBinding(doc, 'search', trusted, 'call').target.kind).toBe('mcp-tool');
    for (const changed of [{ ...trusted, mcpTools: [{ ...descriptor, serverId: 'server-two' }] }, { ...trusted, mcpTools: [{ ...descriptor, enabled: false }] }, { ...trusted, bindings: [{ ...entry, capabilities: [] }] }]) expect(() => resolveBinding(doc, 'search', changed, 'call')).toThrow();
  });
});
describe('registered arguments and literal Call results', () => {
  it('enforces minLength, allowEmpty, additionalProperties and exact number enums', () => {
    const definition = record(decode('{"type":"object","properties":{"query":{"type":"string","minLength":1,"allowEmpty":false},"n":{"type":"integer","enum":[9007199254740993]}},"required":["query"],"additionalProperties":false}'));
    verifyArgumentSchema(definition);
    expect(argumentsSatisfy(decode('{"query":"q","n":9007199254740993.0}'), definition)).toBe(true);
    for (const input of ['{}', '{"query":""}', '{"query":"q","n":9007199254740992}', '{"query":"q","n":true}', '{"query":"q","extra":1}']) expect(argumentsSatisfy(decode(input), definition)).toBe(false);
    expect(() => verifyArgumentSchema(decode('{"type":"string","format":"date"}'))).toThrow('unimplemented');
  });
  it('preserves authored whitespace while Macro still applies its required-string dispatch policy', () => {
    const tool = MACRO_TOOL_REGISTRY.find(entry => entry.id === 'web_search')!;
    const entry = invocationFixture(json('{}'), searchSchema());
    const argumentsJson = json('{"query":"   "}');
    expect(() => validateRegisteredArguments(entry, argumentsJson)).not.toThrow();
    const ordinary = toDispatchValue(argumentsJson);
    expect(validateToolArguments(ordinary, tool.parameters)).toContainEqual({ path: '$.query', message: 'required value is missing' });
    expect(ordinary).toEqual({ query: '   ' });
    expect(argumentsJson).toBe(json('{"query":"   "}'));
  });
  it('checks registered arguments and Call data without converting numbers', () => {
    const entry = invocationFixture(json('{}'), searchSchema());
    expect(() => validateRegisteredArguments(entry, json('{"query":"synthetic"}'))).not.toThrow();
    expect(() => validateRegisteredArguments(entry, json('{"query":""}'))).toThrow('Arguments');
    expect(() => validateRegisteredResult(entry, json('{"ok":true}'))).not.toThrow();
    expect(() => validateRegisteredResult(entry, json('{"ok":1}'))).toThrow('Result');
    expect(() => validateRegisteredResult({ ...entry, resultConstraintJson: json('{"type":"integer","enum":[true]}') }, json('1'))).toThrow('constraint');
  });
});
