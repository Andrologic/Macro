import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type { ConversationContextDiagnostics } from '../../stores/useChatStore';
import { ContextWindowIndicator } from './ContextWindowIndicator';

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

const buildDiagnostics = (): ConversationContextDiagnostics => ({
  status: 'ready',
  conversationId: 'conv-1',
  updatedAt: '2026-05-10T00:00:00.000Z',
  providerId: 'provider-1',
  providerType: 'opencode',
  modelId: 'kimi-k2.6',
  phase: 'compacted',
  decision: 'send',
  compactionPass: 'forced',
  ratio: 0.75,
  usableRatio: 0.82,
  isHardStop: false,
  footprintBefore: {
    totalEstimatedTokens: 120_000,
    serializedPayloadTokens: 110_000,
    messageTokens: 90_000,
    visibleMessageTokens: 20_000,
    providerInputTokens: 65_000,
    hiddenContextTokens: 18_000,
    systemTokens: 2_000,
    toolSchemaTokens: 4_000,
    imagePlaceholderTokens: 0,
    citationTokens: 500,
    summaryTokens: 0,
    latestUserContextTokens: 2_000,
    modelContextWindowTokens: 128_000,
    reservedTokens: 20_000,
    usableContextTokens: 108_000,
    threshold: 'blocking',
    reason: 'total_context_ratio',
    totalContextRatio: 0.94,
    usableContextRatio: 1.11,
    hiddenContextRatio: 0.16,
    hardStopRatio: 0.98,
    isHardStop: false,
    toolTurnCount: 8,
  },
  footprintAfter: {
    totalEstimatedTokens: 96_000,
    serializedPayloadTokens: 88_000,
    messageTokens: 64_000,
    visibleMessageTokens: 18_000,
    providerInputTokens: 30_000,
    hiddenContextTokens: 9_000,
    systemTokens: 2_000,
    toolSchemaTokens: 4_000,
    imagePlaceholderTokens: 0,
    citationTokens: 500,
    summaryTokens: 5_000,
    latestUserContextTokens: 2_000,
    modelContextWindowTokens: 128_000,
    reservedTokens: 20_000,
    usableContextTokens: 108_000,
    threshold: 'blocking',
    reason: 'total_context_ratio',
    totalContextRatio: 0.75,
    usableContextRatio: 0.89,
    hiddenContextRatio: 0.08,
    hardStopRatio: 0.98,
    isHardStop: false,
    toolTurnCount: 8,
  },
  counts: {
    messages: 42,
    visibleLines: 700,
    hiddenContextLines: 180,
    providerInputItems: 35,
    providerInputItemLines: 1_200,
    reasoningContentLines: 80,
    toolResultLines: 260,
    citations: 6,
    activeFiles: 3,
    toolFacts: 12,
  },
  breakdown: [
    { id: 'serialized_payload', label: 'Payload sérialisé final', tokens: 88_000 },
    { id: 'provider_input_items', label: 'Historique provider', tokens: 30_000 },
  ],
  topContributors: [
    { id: 'serialized_payload', label: 'Payload sérialisé final', tokens: 88_000 },
    { id: 'provider_input_items', label: 'Historique provider', tokens: 30_000 },
  ],
});

describe('ContextWindowIndicator', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await flushRender();
    });
    container?.remove();
    container = null;
    root = null;
  });

  it('renders a clockwise fill based on the usable context pressure', async () => {
    await act(async () => {
      root?.render(<ContextWindowIndicator diagnostics={buildDiagnostics()} />);
      await flushRender();
    });

    const fill = document.body.querySelector('[data-testid="context-window-fill"]');
    expect(fill).not.toBeNull();
    expect(fill?.getAttribute('stroke-linecap')).toBe('round');
    expect(fill?.getAttribute('stroke-dasharray')).toBe('82 100');
  });

  it('shows a compacting animation arc', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator diagnostics={buildDiagnostics()} isCompacting />
      );
      await flushRender();
    });

    expect(document.body.querySelector('[data-testid="context-window-compacting"]')).not.toBeNull();
    expect(document.body.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
  });

  it('shows detailed diagnostics and the manual compaction action', async () => {
    const onCompactNow = mock(() => undefined);
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics()}
          onCompactNow={onCompactNow}
        />,
      );
      await flushRender();
    });

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Payload');
    expect(document.body.textContent).toContain('Budget utile');
    expect(document.body.textContent).toContain('Marge');
    expect(document.body.textContent).toContain('Contexte total');
    expect(document.body.textContent).toContain('42 messages · 6 sources');
    expect(document.body.textContent).not.toContain('Le fil a déjà été compacté');

    await act(async () => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Compacter maintenant'))
        ?.click();
      await flushRender();
    });

    expect(onCompactNow).toHaveBeenCalled();
  });
});
