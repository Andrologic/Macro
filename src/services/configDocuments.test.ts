import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { useConfigStore } from '../stores/useConfigStore';
import type { ConfigDocument, ConfigPatchResult } from '../types/generated/config';
import { patchConfigTopLevel } from './configDocuments';

const initialStoreState = useConfigStore.getState();

describe('serialized configuration document mutations', () => {
  let document: ConfigDocument;

  beforeEach(() => {
    document = {
      kind: 'skills',
      scope: { type: 'user' },
      value: { roots: {} },
      etag: 'skills-etag-0',
      readOnly: false,
      invalid: false,
      filePath: 'skills.json',
      diagnostics: [],
    };
  });

  afterEach(() => {
    useConfigStore.setState(initialStoreState, true);
  });

  it('recomputes queued skill source changes from the document written just before them', async () => {
    let revision = 0;
    let releaseFirstPatch: (() => void) | undefined;
    const firstPatchGate = new Promise<void>((resolve) => {
      releaseFirstPatch = resolve;
    });
    const requestedEtags: string[] = [];
    let documentReads = 0;

    useConfigStore.setState({
      getDocument: async () => {
        documentReads += 1;
        return structuredClone(document);
      },
      patch: async (input) => {
        requestedEtags.push(input.expectedEtag);
        if (requestedEtags.length === 1) await firstPatchGate;
        if (input.expectedEtag !== document.etag) throw new Error('stale ETag');
        const operation = input.patch[0];
        if (operation?.op === 'add' && operation.path === '/roots') {
          document = {
            ...document,
            value: { ...(document.value as Record<string, unknown>), roots: operation.value },
            etag: `skills-etag-${++revision}`,
          };
        }
        return {
          status: 'applied',
          document: structuredClone(document),
          pendingChange: null,
          restartRequired: false,
        } satisfies ConfigPatchResult;
      },
    });

    const first = patchConfigTopLevel('skills', { type: 'user' }, 'roots', (current: unknown) => ({
      ...current as Record<string, unknown>,
      alpha: { path: '/skills/alpha' },
    }));
    const second = patchConfigTopLevel('skills', { type: 'user' }, 'roots', (current: unknown) => ({
      ...current as Record<string, unknown>,
      beta: { path: '/skills/beta' },
    }));

    await Promise.resolve();
    await Promise.resolve();
    expect(documentReads).toBe(1);
    releaseFirstPatch?.();
    await Promise.all([first, second]);

    expect(requestedEtags).toEqual(['skills-etag-0', 'skills-etag-1']);
    expect(document.value).toMatchObject({
      roots: {
        alpha: { path: '/skills/alpha' },
        beta: { path: '/skills/beta' },
      },
    });
  });
});
