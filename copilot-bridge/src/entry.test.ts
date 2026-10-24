import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { CodecParent, repository } from './connect-codec.testSupport';
import { codecVectors } from './connect-codec-vectors.testSupport';

const local = process.platform === 'win32' ? it.skip : it;
const invoke = async (entry: string, args: string[]) => {
  const child = Bun.spawn([process.execPath, entry, ...args], { cwd: repository, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', env: { NODE_ENV: 'test' } });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { stdout, stderr, code };
};

describe('AI runtime mode selection', () => {
  it('rejects connect arguments and unknown private modes before importing the codec or Copilot', async () => {
    const entry = resolve(import.meta.dir, 'entry.ts');
    const extra = await invoke(entry, ['connect-codec', 'unexpected']);
    expect(extra).toEqual({ stdout: '', stderr: 'connect_codec_arguments\n', code: 1 });
    const unknown = await invoke(entry, ['connect-unknown']);
    expect(unknown).toEqual({ stdout: '', stderr: 'connect_codec_unknown_mode\n', code: 1 });
    const source = await readFile(entry, 'utf8');
    const imports = new Bun.Transpiler({ loader: 'ts' }).scanImports(source);
    expect(imports.map(entry => entry.path).sort()).toEqual(['./connect-bootstrap', './connect-codec', './connect-transfer', './index']);
    expect(imports.every(entry => entry.kind === 'dynamic-import')).toBe(true);
  });

  local('keeps the SDK unevaluated in a real bundled codec child and preserves historical unknown_command', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'macro-codec-bundle-'));
    try {
      const entry = resolve(import.meta.dir, 'entry.ts');
      const build = async (sentinel: boolean, outdir: string) => {
        const result = await Bun.build({ entrypoints: [entry], target: 'bun', outdir,
          plugins: [{ name: 'synthetic-sdk', setup(builder) {
            builder.onResolve({ filter: /^@github\/copilot-sdk$/ }, () => ({ path: 'sdk', namespace: 'synthetic-sdk' }));
            builder.onLoad({ filter: /.*/, namespace: 'synthetic-sdk' }, () => ({ loader: 'js', contents:
              `${sentinel ? 'throw Error("SDK_EVALUATED");' : ''} export class CopilotClient { constructor(){throw Error("SDK_CONSTRUCTED");} } export const defineTool=(name,options)=>({name,options});` }));
          } }],
        });
        expect(result.logs).toEqual([]); expect(result.success).toBe(true);
        return result.outputs.find(output => output.kind === 'entry-point')!.path;
      };
      const codec = await build(true, join(dir, 'codec'));
      const p = await CodecParent.create(codec, false);
      try {
        const v = codecVectors()[8]!;
        const result = await p.run(v.op, v.facts, v.body);
        expect(result.status).toBe(0); result.dispose();
        expect(await p.finish()).toBe('');
      } finally { await p.cleanup(); }
      const historical = await build(false, join(dir, 'historical'));
      const unknown = await invoke(historical, ['synthetic-unknown']);
      expect(unknown.code).toBe(1); expect(unknown.stderr).toBe('');
      expect(JSON.parse(unknown.stdout)).toMatchObject({ type: 'error', code: 'unknown_command' });
      const buildSource = await readFile(resolve(repository, 'dev/build-ai-runtime.mjs'), 'utf8');
      expect(buildSource).toContain("'copilot-bridge', 'src', 'entry.ts'");
      expect(buildSource).toContain("const OUTPUT_BASENAME = 'macro-ai-runtime'");
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
