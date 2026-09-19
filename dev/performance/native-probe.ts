import { distribution } from './stats';
import { architectSwitchPerf, summarizeArchitectSwitchPerfReports } from '../../src/services/architectSwitchPerf';
import { getPerformanceReports } from '../../src/hooks/usePerformanceMonitor';

type Invoke = (command: string, args?: unknown, options?: unknown) => Promise<unknown>;
type Bridge = { invoke: Invoke };
type Call = { command: string; ms: number; requestJsonBytes: number | null;
  responseJsonBytes: number | null; failed: boolean };
const bytes = (value: unknown): number | null => {
  try {
    if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) return null;
    return new TextEncoder().encode(JSON.stringify(value, (_key, entry) => {
      if (entry instanceof ArrayBuffer || ArrayBuffer.isView(entry)) throw new Error('Binary payload');
      return entry;
    }) ?? '').length;
  } catch { return null; }
};

/** Developer-only native Tauri probe. Import manually in a disposable synthetic
 * profile. No production imports, automatic installation or persistent storage. */
export function installNativeProbe(bridge: Bridge, syntheticProfileConfirmed: true) {
  if (syntheticProfileConfirmed !== true) throw new Error('Confirm a disposable synthetic profile');
  if (typeof bridge?.invoke !== 'function') throw new Error('Native Tauri bridge required');
  const original = bridge.invoke;
  let active: Call[] | null = null;
  let pending = 0;
  let installed = true;
  const wrapped: Invoke = async (command, args, options) => {
    const calls = active;
    if (!calls) return original.call(bridge, command, args, options);
    pending++;
    const requestJsonBytes = bytes(args);
    const start = performance.now();
    let result: unknown;
    let failed = false;
    try {
      result = await original.call(bridge, command, args, options);
      return result;
    } catch (error) {
      failed = true;
      throw error;
    } finally {
      const ms = performance.now() - start;
      calls.push({ command, ms, requestJsonBytes,
        responseJsonBytes: failed ? null : bytes(result), failed });
      pending--;
    }
  };
  bridge.invoke = wrapped;
  return {
    async measure(action: () => Promise<void>) {
      if (!installed || active || pending) throw new Error('Probe unavailable or measurement already active');
      const calls: Call[] = [];
      active = calls;
      const start = performance.now();
      try {
        await action(); // Must resolve only at the declared visual-ready boundary.
        if (pending) throw new Error('IPC still pending at boundary; discard this sample');
        const actionMs = performance.now() - start;
        return { actionMs, calls,
          invalidationCalls: calls.filter((call) => call.command === 'workspace_architect_invalidate').length };
      } finally { active = null; }
    },
    uninstall() {
      if (active || pending) throw new Error('Wait for measurements and IPC before uninstalling');
      if (bridge.invoke !== wrapped) throw new Error('Bridge changed; refusing to overwrite another probe');
      bridge.invoke = original;
      installed = false;
    },
  };
}

export function existingMonitorSummary() {
  // Aggregate only; never export URLs, plan IDs, message text or metadata.
  const reports = getPerformanceReports();
  const metricNames = ['timeToFirstByte', 'domContentLoaded', 'loadComplete', 'react-mount'];
  return {
    architect: summarizeArchitectSwitchPerfReports(architectSwitchPerf.getReports()),
    boot: Object.fromEntries(metricNames.flatMap((name) => {
      const values = reports.map((report) => report.metrics[name]).filter((value) => Number.isFinite(value) && value >= 0);
      return values.length ? [[name, distribution(values)]] : [];
    })),
  };
}
