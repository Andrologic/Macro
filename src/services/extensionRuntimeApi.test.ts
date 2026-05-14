import { describe, expect, it } from 'bun:test';
import {
  clearExtensionRuntimeForTest,
  getExtensionGraphDataProvider,
  getLatestExtensionSelection,
  normalizeSelectionEnvelope,
  notifyExtensionSelectionChanged,
  onExtensionSelectionChanged,
  registerExtensionGraphDataProvider,
  setExtensionViewSelection,
} from './extensionRuntimeApi';

describe('extensionRuntimeApi', () => {
  it('registers and disposes native graph providers', async () => {
    clearExtensionRuntimeForTest();
    const disposable = registerExtensionGraphDataProvider('runtime.macro', 'runtime.macro.graph', {
      getGraph: async () => ({ nodes: [{ id: 'node', label: 'Node' }] }),
    });

    const provider = getExtensionGraphDataProvider('runtime.macro', 'runtime.macro.graph');
    expect(await provider?.getGraph()).toEqual({ nodes: [{ id: 'node', label: 'Node' }] });

    disposable.dispose();
    expect(getExtensionGraphDataProvider('runtime.macro', 'runtime.macro.graph')).toBeNull();
  });

  it('keeps host setSelection separate from delivered selection events', async () => {
    clearExtensionRuntimeForTest();
    let delivered = 0;
    onExtensionSelectionChanged(() => {
      delivered += 1;
    });

    setExtensionViewSelection('runtime.macro', 'runtime.macro.graph', { payload: { id: 'a' } });
    expect(delivered).toBe(0);

    const envelope = normalizeSelectionEnvelope(
      'runtime.macro',
      'runtime.macro.graph',
      { payload: { id: 'a' } },
      'graph',
    );
    await notifyExtensionSelectionChanged(envelope);
    expect(delivered).toBe(1);
  });

  it('tracks the latest selection for an extension across views', () => {
    clearExtensionRuntimeForTest();

    setExtensionViewSelection('runtime.macro', 'runtime.macro.graph', {
      extensionId: 'runtime.macro',
      viewId: 'runtime.macro.graph',
      kind: 'element',
      payload: { id: 'node-1' },
      timestamp: '2026-05-14T00:00:00.000Z',
    });
    expect(getLatestExtensionSelection('runtime.macro')?.payload).toEqual({ id: 'node-1' });

    setExtensionViewSelection('runtime.macro', 'runtime.macro.table', {
      extensionId: 'runtime.macro',
      viewId: 'runtime.macro.table',
      kind: 'row',
      payload: { id: 'row-1' },
      timestamp: '2026-05-14T00:00:01.000Z',
    });
    expect(getLatestExtensionSelection('runtime.macro')?.payload).toEqual({ id: 'row-1' });
  });
});
