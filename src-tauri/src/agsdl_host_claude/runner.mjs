// Original Macro runner. Anthropic dependencies are explicitly installed outside Macro.
// Frames carry exact authored JSON in strings. stdout belongs only to this protocol.
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
const MAX_FRAME = 2_000_000;
let query, release, configured = false, sequence = 0, failed = false;
const pending = new Map(), invocations = new Map();
const send = value => { const line = JSON.stringify(value); if (Buffer.byteLength(line) > MAX_FRAME) throw Error('frame limit'); process.stdout.write(`${line}\n`); };
const fatal = () => { if (failed) return; failed = true; for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(Error('host channel lost')); } pending.clear(); release?.(false); query?.close(); process.exitCode = 1; process.stdin.destroy(); process.stdout.end(); };
function ask(method, params) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(Error('host response timed out')); fatal(); }, 120_000);
    pending.set(id, { resolve, reject, timer }); send({ id, method, params });
  });
}
async function configure(config) {
  if (configured) throw Error('duplicate configuration'); configured = true;
  if (config.sdkVersion !== '0.3.308' || config.cliVersion !== '2.1.308') throw Error('unsupported runtime');
  const sdk = await import(pathToFileURL(config.sdk).href);
  const { z } = await import(pathToFileURL(`${config.zod}/index.js`).href);
  if (config.resume) {
    const info = await sdk.getSessionInfo(config.sessionId, { dir: config.cwd });
    if (!info || info.sessionId !== config.sessionId || info.cwd !== config.cwd) throw Error('reserved session disappeared');
  }
  const aliases = config.tools.map(tool => tool.name);
  const names = [...aliases, ...(config.publication ? ['macro_agsdl_publish'] : [])];
  if (new Set(names).size !== names.length) throw Error('ambiguous aliases');
  const definitions = names.map(name => sdk.tool(name,
    name === 'macro_agsdl_publish' ? 'Publish exact AgSDL JSON. argumentsJson must contain the publication object with results and optional choice.' : `${config.tools.find(t => t.name === name).description}\nPass the complete arguments as an exact JSON string in argumentsJson.`,
    { argumentsJson: z.string() }, async args => {
      // PreToolUse replaces only the transport envelope with an unguessable key.
      // The actual original JSON, name and native id stay in this private table.
      const entry = [...invocations.values()].find(value => value.token === args.argumentsJson);
      if (!entry || entry.name !== name) throw Error('tool lacks native correlation');
      entry.result ??= ask(name === 'macro_agsdl_publish' ? 'publish' : 'tool', { toolUseId: entry.id, name, argumentsJson: entry.argumentsJson });
      const response = await entry.result;
      if (typeof response.resultJson !== 'string' || typeof response.failed !== 'boolean') throw Error('invalid host response');
      return { content: [{ type: 'text', text: response.resultJson }], isError: response.failed };
    }, { alwaysLoad: true }));
  const mcp = sdk.createSdkMcpServer({ name: 'macro', version: '1.0.0', tools: definitions, alwaysLoad: true });
  const gate = new Promise(resolve => { release = resolve; });
  const deny = () => ({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'Macro rejected an uncorrelated operation.' } });
  const pre = async (input, id, { signal }) => {
    if (signal.aborted || input.session_id !== config.sessionId || input.mcp_server?.source !== 'sdk'
      || input.mcp_server?.name !== 'macro' || input.cwd !== config.cwd || input.permission_mode !== 'default' || input.agent_id != null || !id || input.tool_use_id !== id || !input.tool_name.startsWith('mcp__macro__')) return deny();
    const name = input.tool_name.slice('mcp__macro__'.length);
    if (!names.includes(name) || typeof input.tool_input?.argumentsJson !== 'string'
      || Object.keys(input.tool_input).some(key => key !== 'argumentsJson')) return deny();
    const previous = invocations.get(id);
    if (previous && (previous.name !== name || previous.argumentsJson !== input.tool_input.argumentsJson)) return deny();
    if (!previous && invocations.size >= 1000) return deny();
    const entry = previous ?? { id, name, argumentsJson: input.tool_input.argumentsJson, token: randomUUID() };
    invocations.set(id, entry);
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { argumentsJson: entry.token } } };
  };
  const settings = { autoMemoryEnabled: false, disableClaudeAiConnectors: true, enabledPlugins: { 'cc-plugin-agents-md@builtin': false, 'cc-plugin-plugin-authoring@builtin': false }, hooks: {}, permissions: { allow: [], deny: [] } };
  const options = {
    pathToClaudeCodeExecutable: config.cli, cwd: config.cwd, env: { ...process.env },
    tools: [], skills: [], plugins: [], settingSources: [], strictMcpConfig: true,
    mcpServers: { macro: mcp }, allowedTools: names.map(name => `mcp__macro__${name}`),
    permissionMode: 'default', verbatimPrompts: true, persistSession: true,
    ...(config.resume ? { resume: config.sessionId } : { sessionId: config.sessionId }),
    model: config.model, systemPrompt: config.initialization, settings,
    ...(config.maxTurns === null ? {} : { maxTurns: config.maxTurns }),
    ...(config.effort === null ? {} : { effort: config.effort }),
    ...(config.qa ? { maxBudgetUsd: 0.05 } : {}),
    hooks: { PreToolUse: [{ timeout: 120, hooks: [pre] }] },
    canUseTool: async () => ({ behavior: 'deny', message: 'Only correlated Macro tools are available.' }),
    stderr: () => {},
    spawnClaudeCodeProcess: options => {
      const child = spawn(options.command, options.args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] });
      // Revoke admission immediately, even while the SDK waits for a host tool.
      // Buffered SDK result frames may still provide an authoritative receipt.
      child.once('exit', () => { if (!failed) send({ method: 'nativeExit' }); }); child.once('error', fatal); return child;
    },
  };
  query = sdk.query({ options, prompt: (async function* () { if (await gate) yield { type: 'user', session_id: config.sessionId, message: { role: 'user', content: config.input }, uuid: config.userMessageUuid, parent_tool_use_id: null }; })() });
  const initialized = await query.initializationResult();
  const mcpStatus = await query.mcpServerStatus();
  const models = await query.supportedModels();
  const selected = models.find(model => model.value === config.model || model.resolvedModel === config.model);
  if (!selected || config.effort !== null && (!selected.supportsEffort || !selected.supportedEffortLevels?.includes(config.effort))) throw Error('model or effort unavailable');
  await ask('ready', { nodeVersion: process.versions.node, initialized, mcpStatus, models, settings: { tools: [], skills: [], plugins: [], settingSources: [], strictMcpConfig: true, verbatimPrompts: true, model: config.model, effort: config.effort, maxTurns: config.maxTurns, maxBudgetUsd: config.qa ? 0.05 : null, maxOutputTokens: config.qa ? 1024 : null } });
  if (config.diagnostic) { release(false); query.close(); send({ method: 'diagnosticEnd' }); return; }
  release(true);
  for await (const frame of query) {
    if (frame.type === 'assistant' || frame.type === 'user' || frame.type === 'result' || frame.type === 'system') await ask('frame', { frame });
    if (frame.type === 'result') { query.close(); return; }
  }
  throw Error('native query ended without result');
}
const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
input.on('line', line => {
  try {
    if (Buffer.byteLength(line) > MAX_FRAME) throw Error('frame limit');
    const value = JSON.parse(line);
    if (value.method === 'configure') void configure(value.params).catch(() => { send({ method: 'fatal' }); fatal(); });
    else {
      const waiting = pending.get(value.id); if (!waiting) throw Error('unknown host response');
      pending.delete(value.id); clearTimeout(waiting.timer);
      if (value.error) { waiting.reject(Error('host refused')); fatal(); } else waiting.resolve(value.result);
    }
  } catch { fatal(); }
});
input.on('close', fatal);
process.on('SIGTERM', fatal);
process.on('SIGINT', fatal);
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);
