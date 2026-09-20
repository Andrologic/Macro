import { cpus, totalmem, platform, release, arch } from 'node:os';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { buildChatTranscriptItems } from '../../src/components/chat/transcriptItems';
import { findTerminalSearchMatches } from '../../src/services/terminalSearch';
import { createArchitectSwitchPerfRuntime } from '../../src/services/architectSwitchPerf';
import { usePerformanceMonitor } from '../../src/hooks/usePerformanceMonitor';
import { benchmark } from './stats';
import { fixtureSizes, messages, terminal } from './fixtures';
import { sqliteBaseline } from './sqlite';

const root = new URL('../../', import.meta.url);
const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
let sink = 0;
const disabled = createArchitectSwitchPerfRuntime({ enabled: false,
  now: () => { throw new Error('Disabled instrumentation read its clock'); },
  logger: { info: () => { throw new Error('Disabled instrumentation logged'); } },
  performanceApi: { mark: () => { throw new Error('Disabled instrumentation marked'); } },
});
const callback = () => ++sink;
assert.equal(disabled.measureSwitchPhase(1, 'app_prehydrate', callback), 1);
assert.deepEqual(disabled.getReports(), []);
function Empty() { return null; }
function Monitor() {
  const monitor = usePerformanceMonitor();
  monitor.mark('synthetic');
  assert.equal(monitor.measure('synthetic'), 0);
  return null;
}
const batch = (run: () => unknown) => () => { for (let i = 0; i < 10_000; i++) run(); };
const rows = fixtureSizes.map((size) => {
  const input = messages(size);
  const compactionEvents = input.filter((_, i) => i % 100 === 99).map((message, i) => ({
    id: `event-${i}`, status: 'completed' as const, displayAfterMessageId: message.id,
  }));
  assert.equal(buildChatTranscriptItems(input, { compactionEvents }).length, size + compactionEvents.length);
  const buffer = terminal(size);
  assert.equal(findTerminalSearchMatches(buffer, 'match').length, size);
  return { size, transcript: benchmark(() => { sink += buildChatTranscriptItems(input, { compactionEvents }).length; }),
    terminalSearch: benchmark(() => { sink += findTerminalSearchMatches(buffer, 'match').length; }),
    sqlite: sqliteBaseline(size) };
});
console.log(JSON.stringify({ schema: 1, kind: 'synthetic-product-microbenchmarks',
  environment: { timestamp: new Date().toISOString(), bun: Bun.version, platform: platform(),
    release: release(), arch: arch(), cpu: cpus()[0].model, cpuCount: cpus().length,
    memoryGiB: totalmem() / 2 ** 30, head: git('rev-parse', 'HEAD'),
    dirty: Boolean(git('status', '--porcelain', '--untracked-files=normal')) },
  protocol: { warmup: 10, samples: 100, percentile: 'nearest-rank', sequential: true,
    messageBytes: 256, terminalColumns: 120, compactionEvery: 100 }, rows,
  instrumentation: { batchCalls: 10_000, direct: benchmark(batch(callback)),
    architectDisabled: benchmark(batch(() => disabled.measureSwitchPhase(1, 'app_prehydrate', callback))),
    emptySSR: benchmark(() => renderToString(createElement(Empty))),
    monitorDisabledSSR: benchmark(() => renderToString(createElement(Monitor))),
    caveat: 'SSR includes React and assertions; no browser effects, not a production render timing.' },
  unavailable: ['workspace/chat/terminal visual navigation', 'native IPC volumes and latency',
    'catalog invalidation fanout', 'SQLite disk/SQLx/metadata refresh', 'bundle sizes: run bundle command separately'],
  sink,
}, null, 2));
