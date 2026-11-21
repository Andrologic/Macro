// Deterministic test inputs from the pinned files, public TS vectors and synthetic captures.
import { readFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { decode, encode, record, type ExactObject } from '../../src/services/agsdlExecution/exact';
import { evaluateCompile030 } from './compile-oracle030';
export async function buildCompileCorpus030() {
    const root = process.cwd();
    const cases: {
        id: string;
        family: string;
        op: string;
        json: string;
    }[] = [];
    const files: unknown[] = [];
    const digest = (s: string) => createHash('sha256').update(s).digest('hex');
    function add(family: string, op: string, input: unknown, raws: Record<string, string> = {}) { let json = JSON.stringify(input); for (const [token, raw] of Object.entries(raws))
        json = json.replaceAll(JSON.stringify(token), raw); cases.push({ id: `${family}:${cases.length}`, family, op, json }); }
    const moduleNames = ['codex', 'claude-code', 'opencode', 'pi'];
    const modules = moduleNames.map(harness => ({ harness, moduleJson: readFileSync(root + `/src/vendor/agsdl/v0.3/harnesses/${harness}/module.json`, 'utf8') }));
    const baseCaps = ['result-submission', 'continuity', 'permission-enforcement', 'contained-stop', 'response-attribution', 'completion-check', 'resources', 'model.name', 'model.effort', 'skills', 'mcpServers', 'plan', 'planFirst.auto', 'planFirst.ask', 'reviewer.person', 'reviewer.model', 'directories', 'instance.new', 'delivery.steer', 'delivery.queue', 'instructions', 'answer-timeout', 'harness-settings'];
    const evidence = '{"synthetic":"compile-corpus"}';
    function source(authored: string) { return { owner: { projectId: 'synthetic', planId: 'synthetic', branch: 'feature/synthetic' }, revision: '1', sourceSha256: digest(authored) }; }
    function fixture(authored: string, pinned = false) {
        let document: ExactObject;
        try {
            document = record(decode(authored));
        }
        catch {
            document = {};
        }
        ;
        let agents: Record<string, unknown>[] = [];
        let harnesses: Record<string, unknown>[] = [];
        for (const [name, value] of Object.entries(record(document.agents ?? {}))) {
            let agent: ExactObject;
            try {
                agent = record(value);
            }
            catch {
                continue;
            }
            ;
            const harness = typeof agent.harness === 'string' ? agent.harness : 'synthetic';
            if (!harnesses.some(h => h.harness === harness)) {
                harnesses.push({ harness, version: '1.0.0', installation: 'available', adapterId: harness === 'codex' ? 'codex-app-server-v1' : 'synthetic-adapter', qualified: true, capabilities: baseCaps.map(name => ({ name, support: 'native', evidenceJson: evidence })), models: [{ name: 'synthetic-model', efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }], defaultModel: 'synthetic-model' });
            }
            const h = harnesses.find(h => h.harness === harness)! as any;
            const model = typeof agent.model === 'object' && agent.model !== null && !Array.isArray(agent.model) ? agent.model as ExactObject : {};
            if (typeof model.name === 'string' && !h.models.some((m: { name: string }) => m.name === model.name)) {
                h.models.push({ name: model.name, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' });
            }
            if (typeof model.effort === 'string') {
                for (const m of h.models)
                    if (!m.efforts.includes(model.effort))
                        m.efforts.push(model.effort);
            }
            agents.push({ agentName: name, agentDeclarationJson: encode(agent), settingsJson: encode(agent.harnessSettings ?? {}), permissionsJson: evidence, scopeJson: evidence, evidenceJson: evidence, provenanceJson: evidence });
        }
        const registry = { format: 'macro-agsdl-registry/030', version: 'synthetic-registry', modules: pinned ? modules : [], harnesses, agents, hostCapabilities: ['call.command', 'call.mcp', 'approval'].map(name => ({ name, support: 'native', evidenceJson: evidence })) };
        return { authored, source: source(authored), registry };
    }
    function paths(dir: string): string[] { return readdirSync(root + '/' + dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? paths(dir + '/' + e.name) : e.name.endsWith('.json') ? [dir + '/' + e.name] : []).sort(); }
    for (const [directory, family] of [['dev/agsdl/fixtures/v0.3/conformance/cases', 'official'], ['dev/agsdl/fixtures/v0.3/conformance/runs', 'runs'], ['dev/agsdl/fixtures/v0.3/examples', 'examples'], ['src/demo/agsdl', 'demo']]) {
        for (const path of paths(directory)) {
            if (family === 'demo' && !path.endsWith('.agsdl.json'))
                continue;
            const bytes = readFileSync(root + '/' + path, 'utf8');
            files.push({ path, sha256: digest(bytes) });
            let authored = bytes;
            try {
                const obj = record(decode(bytes));
                if (obj.document)
                    authored = encode(obj.document);
            }
            catch { /* Invalid fixture bytes are intentionally submitted unchanged. */ }
            ;
            for (const pinned of [false, true]) {
                let input;
                try {
                    input = fixture(authored, pinned);
                }
                catch {
                    input = { authored, source: source(authored), registry: { format: 'macro-agsdl-registry/030', version: 'synthetic', modules: [], harnesses: [], agents: [] } };
                }
                ;
                add(family, 'plan', input);
                add(family, 'host', { ...input, registry: { ...input.registry, startEntry: null, deliveryInput: { agentName: 'worker', messageJson: '{"prompt":"Fixture"}' }, callInput: { inputJson: '{"value":9007199254740993}' } } });
            }
        }
    }
    const base = fixture('{"contract":"agsdl-0.3.0","id":"test","agents":{"worker":{"harness":"synthetic","permissions":"read-only"}}}');
    for (const op of ['plan', 'host', 'registry', 'agent']) {
        add('baseline', op, { ...base, document: base.authored, agentName: 'worker' });
    }
    const copy = (v: unknown) => structuredClone(v) as any;
    const mutations = [(r: any) => r.version = '', (r: any) => r.format = 'bad', (r: any) => r.agents.push(copy(r.agents[0])), (r: any) => r.harnesses.push(copy(r.harnesses[0])), (r: any) => r.harnesses[0].models[0].efforts.push('medium'), (r: any) => r.harnesses[0].defaultModel = 'missing', (r: any) => r.harnesses[0].models[0].defaultEffort = 'missing', (r: any) => r.harnesses[0].qualified = 'yes', (r: any) => r.harnesses[0].qualified = false, (r: any) => r.harnesses[0].adapterId = null, (r: any) => r.harnesses[0].version = null, (r: any) => r.harnesses[0].installation = 'missing', (r: any) => r.agents[0].permissionsJson = '{}', (r: any) => r.agents[0].agentDeclarationJson = '{}', (r: any) => r.agents[0].settingsJson = '{"apiKey":"synthetic"}', (r: any) => r.agents[0].settingsJson = '{"early":{"password":"synthetic"},"token":"synthetic"}', (r: any) => r.harnesses[0].capabilities.splice(0, 1), (r: any) => r.harnesses[0].capabilities[0].support = 'approximate', (r: any) => r.harnesses[0].capabilities[0].evidenceJson = '{}'];
    for (const mutate of mutations) {
        const input = copy(base);
        mutate(input.registry);
        for (const op of ['plan', 'host', 'registry', 'agent'])
            add('registry-mutations', op, { ...input, document: input.authored, agentName: 'worker' });
    }
    for (const field of ['modules', 'harnesses', 'agents', 'hostCapabilities'])
        for (const v of [null, {}, 0, 'x', [], [null], [false]]) {
            const input = copy(base);
            input.registry[field] = v;
            for (const op of ['registry', 'plan', 'host'])
                add('registry-shape', op, input);
        }
    for (const raw of ['null', '{}', '[]', '" "', 'false', '1', '0', '1e400', '"ok"', '[0]', '{"receipt":true}'])
        for (const field of ['permissionsJson', 'scopeJson', 'evidenceJson', 'provenanceJson']) {
            const input = copy(base);
            input.registry.agents[0][field] = raw;
            for (const op of ['registry', 'plan'])
                add('receipts', op, input);
        }
    for (const text of ['\ud800', '\udc00', '𝄞', '\ufeff', '\u0085', '\u00a0', ' \ud800 ']) {
        for (const field of ['version', 'defaultModel']) {
            const input = copy(base);
            if (field === 'version')
                input.registry.version = text;
            else {
                input.registry.harnesses[0].models[0].name = text;
                input.registry.harnesses[0].defaultModel = text;
            }
            for (const op of ['plan', 'host', 'registry'])
                add('native-utf16', op, input);
        }
        const input = copy(base);
        input.source.owner.projectId = text;
        for (const op of ['source', 'plan', 'host'])
            add('native-source-utf16', op, op === 'source' ? { value: input.source } : input);
    }
    for (const raw of ['9007199254740993', '-0', '1e400', '-1e400', '5e-324', '1e-6', '1e20', '1e21', '0.123456789012345678901']) {
        const input = copy(base);
        input.registry.harnesses[0].extra = '$number';
        input.registry.agents[0].extra = { b: '$number', '2': false, '1': true };
        input.registry.deliveryInput = { agentName: 'worker', messageJson: '{"prompt":"Hello"}', extra: '$number' };
        input.registry.callInput = { extra: '$number' };
        input.source.owner.extra = '$number';
        add('native-numbers', 'host', input, { '$number': raw });
        add('native-numbers', 'plan', input, { '$number': raw });
    }
    for (const authored of ['{', '[]', 'true', '{"x":"\ud800"}', '{"contract":"agsdl-0.3.0","id":"test","agents":{}}', '{"a":1,"a":2}', '\ufeff{}']) {
        const input = { ...copy(base), authored, source: source(authored) };
        for (const op of ['host', 'plan'])
            add('source-refusals', op, input);
        add('read', 'read', { source: authored });
    }
    for (const value of [null, {}, [], 1, true, '', { 'a/b~c': ['$overflow'] }])
        for (const fn of ['object', 'text', 'identity', 'array', 'json'])
            add('metadata', 'metadata', { value, fn, pointer: '/test' }, { '$overflow': '1e400' });
    for (const raw of ['{}', '{"instructs":true}', '{"maxCorrections":9007199254740993}', '{"maxCorrections":-0}', '{"maxCorrections":"3"}', '{"maxCorrections":-1}', '{"answerTimeoutMs":1e9999}', '{"answerTimeoutMs":0}', '{"completionCheck":{"command":"test","choices":["other"],"maxFailures":2e0}}', '{"completionCheck":{"command":"  "}}', '{"completionCheck":{"command":"test","maxFailures":1.5}}', '{"planFirst":"ask"}', '{"planFirst":"bad"}']) {
        for (const route of [{}, { choices: ['send', 'done'], instructionsByChoice: { send: 'list', done: 'none' } }, { choices: ['send'], defaultInstructions: 'string' }, { choices: [] }, { choices: ['same', 'same'] }, { choices: [''], instructionsByChoice: {} }, { choices: ['x'], instructionsByChoice: { unknown: 'string' } }, { defaultInstructions: 'bad' }]) {
            const input = { agentJson: raw, ...route };
            add('contracts', 'contract', { input });
            const out = JSON.parse(await evaluateCompile030({ op: 'contract', json: JSON.stringify({ input }) }));
            if (out.status === 'ok') {
                const contract = JSON.parse(out.json);
                add('contracts-copy', 'copyContract', { contract });
                add('contracts-copy', 'copyContract', { contract: { ...contract, maxCorrections: '999' } });
            }
        }
    }
    for (const field of ['maxCorrections', 'answerTimeoutMs', 'completionCheck', 'planFirst', 'harnessSettings', 'model']) {
        for (const value of [0, 1, true, null, {}, [], { command: 'test' }, 'ask']) {
            const agent = { harness: 'synthetic', permissions: 'read-only', [field]: value };
            const authored = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'generated', agents: { worker: agent } });
            const input = fixture(authored);
            add('agent-properties', 'plan', input);
        }
    }
    for (let i = 0; i < 200; i++) {
        const n = (i % 9) + 1;
        const agent = `{"harness":"synthetic","permissions":"read-only","maxCorrections":${n}e0}`;
        const authored = `{"contract":"agsdl-0.3.0","id":"generated${i}","agents":{"worker":${agent}},"flow":{"entry":"work","steps":{"work":{"type":"agent","agent":"worker","maxVisits":${i + 1}.0}}}}`;
        const input = fixture(authored) as any;
        add('generated', 'plan', input);
        add('generated', 'host', { ...input, registry: { ...input.registry, startEntry: { messageJson: i % 3 === 0 ? '{}' : i % 3 === 1 ? '{"prompt":"Hi"}' : '{"prompt":[{"uri":"file:///synthetic"}]}' } } });
        add('generated', 'graph', { document: authored });
        add('used', 'used', { document: authored, agentName: 'worker', agent, pointer: '/agents/worker' });
    }
    add('snapshots', 'snapshot', { ...base, mutateSourceOwner: { projectId: 'mutated' }, mutateAgent: { settingsJson: '{"changed":true}' } });
    for (const messageJson of ['{}', '{"prompt":""}', '{"prompt":null}', '{"resources":{"n":{"value":9007199254740993}}}', '{"prompt":[{"uri":"relative.txt"}]}', '{"prompt":[{"ref":"missing"}]}', '{"item":null}']) {
        const graphless = copy(base);
        graphless.registry.deliveryInput = { agentName: 'worker', messageJson };
        add('delivery', 'host', graphless);
        for (const type of ['agent', 'approval', 'compose', 'call', 'join']) {
            let doc: any = { contract: 'agsdl-0.3.0', id: 'entry', agents: { worker: { harness: 'synthetic', permissions: 'read-only' } }, flow: { entry: 'work', steps: { work: type === 'agent' ? { type, agent: 'worker' } : type === 'approval' ? { type, next: { yes: [] } } : type === 'call' ? { type, command: 'true' } : { type } } } };
            const input = fixture(JSON.stringify(doc)) as any;
            input.registry.startEntry = { messageJson };
            add('entry', 'host', input);
        }
    }
    let seed = 0x2c3;
    function rnd() { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed; }
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';
    for (let i = 0; i < 2000; i++) {
        const make = () => { let s = alphabet[rnd() % 52]; for (let j = 0, n = rnd() % 15; j < n; j++)
            s += alphabet[rnd() % alphabet.length]; return s; };
        const left = make() + '/' + make(), right = i % 2 === 0 ? left.toUpperCase() : make() + '/' + make();
        add('address-order', 'addressOrder', { left, right });
    }
    // Full graph/configuration exports on the static-valid domain of their callers.
    const { read } = await import('../../src/vendor/agsdl/v0.3/reader.mjs');
    for (const file of files as {
        path: string;
    }[]) {
        let authored = readFileSync(root + '/' + file.path, 'utf8');
        let document: ExactObject;
        try {
            document = record(decode(authored));
            if (document.document) {
                authored = encode(document.document);
                document = record(document.document);
            }
        }
        catch {
            continue;
        }
        if (!read(new TextEncoder().encode(authored), { modules: new Map() }).valid)
            continue;
        add('graph-files', 'graph', { document: authored });
        const input = fixture(authored);
        for (const [agentName, agent] of Object.entries(record(document.agents ?? {}))) {
            add('configuration-files', 'agent', { document: authored, agentName, registry: input.registry });
            add('used-files', 'used', { document: authored, agentName, agent: encode(agent), pointer: '/agents/' + agentName.replaceAll('~', '~0').replaceAll('/', '~1') });
        }
    }
    for (const range of ['^1.0.0 || >=3.0.0-beta.2', '>=1.0.0']) {
        const doc = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'range', agents: { worker: { harness: 'synthetic', permissions: 'read-only', harnessVersion: range } } });
        for (const mode of ['missing', 'native', 'wrong-version', 'false', 'empty', 'surrogate-version']) {
            const input = fixture(doc) as any;
            if (mode === 'surrogate-version')
                input.registry.harnesses[0].version = '\ud800';
            if (mode !== 'missing')
                input.registry.harnesses[0].capabilities.push({ name: 'range-proof', support: 'native', evidenceJson: JSON.stringify({ kind: 'harness-version-range', harness: 'synthetic', version: mode === 'wrong-version' ? '2.0.0' : '1.0.0', range, satisfied: mode !== 'false', receipt: mode === 'empty' ? '' : { synthetic: true } }) });
            for (const op of ['plan', 'host', 'agent'])
                add('range-proof', op, { ...input, document: doc, agentName: 'worker' });
        }
    }
    const module = { name: 'synthetic', version: '1.0.0', contract: 'agsdl-0.3.0', harnessVersions: '>=1.0.0', properties: { 'planFirst.auto': { support: 'native' }, 'resources': { support: 'native' } }, permissions: { read: { deny: 'sandbox', outside: 'sandbox' }, write: { deny: 'sandbox' }, shell: { deny: 'sandbox' }, network: { deny: 'sandbox' }, mcp: { deny: 'sandbox' }, delegate: { deny: 'sandbox' } }, settings: { type: 'object', properties: { budget: { type: 'number' }, verbosity: { type: 'string' } }, additionalProperties: false } };
    for (const settings of ['{}', '{"budget":1e999999,"verbosity":"brief"}', '{"verbosity":"native-default"}', '{"unknown":true}', '{"password":"synthetic"}', '{"early":{"password":"synthetic"},"token":"later"}', '{"verbosity":"Bearer synthetic"}', '{"verbosity":"sk-1234567890123456"}', '{"verbosity":"ſk-1234567890123456"}']) {
        const agent = `{"harness":"synthetic","permissions":"read-only","harnessSettings":${settings},"planFirst":"auto"}`;
        const doc = `{"contract":"agsdl-0.3.0","id":"settings","agents":{"worker":${agent}}}`;
        for (const mode of ['none', 'module', 'mismatch', 'approximate', 'module-warning']) {
            const input = fixture(doc) as any;
            if (mode !== 'none')
                input.registry.modules = [{ harness: 'synthetic', moduleJson: JSON.stringify({ ...module, properties: { ...module.properties, 'planFirst.auto': { support: mode === 'module-warning' ? 'approximate' : 'native' } } }) }];
            if (mode === 'mismatch')
                input.registry.agents[0].settingsJson = '{}';
            if (mode === 'approximate')
                input.registry.harnesses[0].capabilities.find((c: { name: string }) => c.name === 'planFirst.auto').support = 'approximate';
            for (const op of ['registry', 'agent', 'plan', 'host'])
                add('settings', op, { ...input, document: doc, agentName: 'worker' });
        }
    }
    for (const owner of [null, {}, 1, { projectId: 'p', planId: 'p', branch: 'b' }, { projectId: ' ', planId: 'p', branch: 'b' }])
        for (const revision of ['0', '01', 1, null, '10000000000000000000000000000000000000']) {
            const input = copy(base);
            input.source.owner = owner;
            input.source.revision = revision;
            for (const op of ['source', 'plan', 'host'])
                add('source-shape', op, op === 'source' ? { value: input.source } : input);
        }
    for (const sha of ['f'.repeat(64), 'F'.repeat(64), '', '0', null, 1]) {
        const input = copy(base);
        input.source.sourceSha256 = sha;
        for (const op of ['source', 'plan', 'host'])
            add('source-sha', op, op === 'source' ? { value: input.source } : input);
    }
    for (const type of ['command', 'mcp', 'approval']) {
        const authored = JSON.stringify({ contract: 'agsdl-0.3.0', id: 'host-only', agents: {}, ...(type === 'mcp' ? { mcpServers: { server: { command: ['synthetic'] } } } : {}), flow: { entry: 'run', steps: { run: type === 'command' ? { type: 'call', command: 'true' } : type === 'mcp' ? { type: 'call', mcp: { server: 'server', tool: 'tool' } } : { type: 'approval', next: { yes: [] } } } } });
        const input = fixture(authored);
        add('host-only', 'plan', input);
        add('host-only', 'host', { ...input, registry: { ...input.registry, startEntry: { messageJson: '{"prompt":"Host"}' } } });
    }
    // Byte boundary vectors exercise the actual exported transport encoder.
    const baselineResult = JSON.parse((JSON.parse(await evaluateCompile030({ op: 'plan', json: JSON.stringify(base) }))).json);
    const validations = { entryValidation: { messageJson: '{"prompt":"Hello"}', valid: true, shapeValid: true, unassessed: [] }, deliveryValidation: { input: { agentName: 'worker', messageJson: '{}' }, valid: true }, callValidation: { input: { valueJson: '{"n":9007199254740993}' }, prepared: { authorized: true } } };
    for (const multibyte of [false, true])
        for (const target of [7999999, 8000000, 8000001]) {
            const result = copy(baselineResult);
            result.static = { valid: true, diagnostics: [{ code: 'EXPANDED', pointer: '', message: '', severity: 'warning' }] };
            const fixed = new TextEncoder().encode(JSON.stringify({ ...result, capturedRegistryJson: JSON.stringify(base.registry), ...validations })).length;
            const n = target - fixed;
            result.static.diagnostics[0].message = multibyte ? 'é'.repeat(Math.floor(n / 2)) + 'x'.repeat(n % 2) : 'x'.repeat(n);
            add('utf8-limit', 'encodeHost', { result, registry: base.registry, validations });
        }
    const standing = 'x'.repeat(20000);
    const expanded: any = { contract: 'agsdl-0.3.0', id: 'expanded-plan', agents: { worker: { harness: 'synthetic', permissions: 'read-only', instructions: standing } }, compositions: { body: { parameters: ['who'], entry: 'work', outputs: ['done'], steps: { work: { type: 'agent', agent: { parameter: 'who' }, instance: 'new', next: { output: 'done' } } } } }, flow: { entry: 'c0', steps: {} } };
    for (let i = 0; i < 210; i++)
        expanded.flow.steps['c' + i] = { type: 'compose', composition: 'body', agents: { who: 'worker' }, next: { done: i === 209 ? [] : 'c' + (i + 1) } };
    const expandedInput = fixture(JSON.stringify(expanded));
    add('expanded-plan', 'host', { ...expandedInput, registry: { ...expandedInput.registry, startEntry: { messageJson: '{}' } } });
    const nativeInput = copy(base);
    nativeInput.source.owner.projectId = String.fromCharCode(0xd800);
    nativeInput.registry.version = String.fromCharCode(0xdc00);
    nativeInput.registry.modules = copy(modules);
    nativeInput.registry.modules[0].extra = { [String.fromCharCode(0xd800)]: ['$huge', 'é'], b: true, '2': 2, '1': 1 };
    nativeInput.registry.harnesses[0].version = String.fromCharCode(0xd800);
    nativeInput.registry.harnesses[0].models[0].name = String.fromCharCode(0xdc00);
    nativeInput.registry.harnesses[0].defaultModel = String.fromCharCode(0xdc00);
    nativeInput.registry.harnesses[0].models[0].efforts = [String.fromCharCode(0xd800, 0xd800)];
    nativeInput.registry.harnesses[0].models[0].defaultEffort = String.fromCharCode(0xd800, 0xd800);
    nativeInput.registry.callInput = { extra: '$huge', key: String.fromCharCode(0xdc00) };
    for (const op of ['host', 'plan', 'registry', 'agent'])
        add('native-complete', op, { ...nativeInput, document: nativeInput.authored, agentName: 'worker' }, { '$huge': '1e400' });
    for (const p of ['permissionsJson', 'settingsJson', 'scopeJson', 'evidenceJson', 'provenanceJson', 'agentDeclarationJson']) {
        const input = copy(base);
        input.registry.agents[0][p] = String.fromCharCode(0xd800);
        for (const op of ['host', 'plan', 'registry', 'agent'])
            add('native-exact-refusals', op, { ...input, document: input.authored, agentName: 'worker' });
    }
    return { cases, files };
}
