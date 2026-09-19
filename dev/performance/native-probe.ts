import { distribution } from './stats';
import { architectSwitchPerf, summarizeArchitectSwitchPerfReports } from '../../src/services/architectSwitchPerf';
import { getPerformanceReports } from '../../src/hooks/usePerformanceMonitor';

type Invoke = (command: string, args?: unknown, options?: unknown) => Promise<unknown>;
type Bridge = { invoke: Invoke };
type Call = { command: string; ms: number; requestJsonBytes: number | null;
  responseJsonBytes: number | null; failed: boolean };
// Snapshot only plain data descriptors; never invoke a getter or toJSON.
// Proxy objects are outside this developer tool's synthetic-data contract.
const bytes = (value: unknown): number | null => {
  const seen = new Set<object>();
  const snapshot = (entry: unknown): unknown => {
    if (entry === null || typeof entry === 'string' || typeof entry === 'boolean' ||
        typeof entry === 'number' || typeof entry === 'undefined') return entry;
    if (typeof entry !== 'object' || seen.has(entry)) throw new Error('Non-JSON data');
    const prototype = Object.getPrototypeOf(entry);
    if (prototype !== Object.prototype && prototype !== Array.prototype && prototype !== null) {
      throw new Error('Non-plain object');
    }
    for (let proto = prototype; proto; proto = Object.getPrototypeOf(proto)) {
      if (Object.getOwnPropertyDescriptor(proto, 'toJSON')) throw new Error('Custom serialization');
    }
    const descriptors = Object.getOwnPropertyDescriptors(entry);
    if (descriptors.toJSON || Object.values(descriptors).some((descriptor) => !('value' in descriptor))) {
      throw new Error('Accessor or custom serialization');
    }
    seen.add(entry);
    const copy = Array.isArray(entry) ? [] : Object.create(null);
    if (Array.isArray(copy)) Object.setPrototypeOf(copy, null);
    for (const [key, descriptor] of Object.entries(descriptors)) {
      Object.defineProperty(copy, key, { ...descriptor, value: snapshot(descriptor.value) });
    }
    seen.delete(entry);
    return copy;
  };
  try {
    return new TextEncoder().encode(JSON.stringify(snapshot(value)) ?? '').length;
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
