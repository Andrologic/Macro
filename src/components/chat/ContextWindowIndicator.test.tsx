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

const buildDiagnostics = (
  overrides: Partial<ConversationContextDiagnostics> = {},
): ConversationContextDiagnostics => ({
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
  ...overrides,
});

describe('ContextWindowIndicator', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    originalMatchMedia = window.matchMedia;
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
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: originalMatchMedia,
    });
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
    expect(document.body.querySelector('[data-testid="context-window-compacting-spinner"]')).not.toBeNull();
    expect(document.body.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');
  });

  it('shows a compacting label in the popover while compaction is active', async () => {
    await act(async () => {
      root?.render(<ContextWindowIndicator diagnostics={buildDiagnostics()} isCompacting />);
      await flushRender();
    });

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Compaction en cours');
  });

  it('shows a live measurement label in the popover', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator diagnostics={buildDiagnostics({ source: 'live_stream' })} />,
      );
      await flushRender();
    });

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Mesure en direct');
  });

  it('closes the popover when clicking outside of it', async () => {
    await act(async () => {
      root?.render(<ContextWindowIndicator diagnostics={buildDiagnostics()} />);
      await flushRender();
    });

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Payload');

    await act(async () => {
      document.body.dispatchEvent(
        new Event('pointerdown', { bubbles: true, cancelable: true }),
      );
      await flushRender();
    });

    expect(document.body.textContent).not.toContain('Payload');
  });

  it('keeps the popover open when interacting inside it', async () => {
    const onRefresh = mock(() => undefined);
    await act(async () => {
      root?.render(
        <ContextWindowIndicator diagnostics={buildDiagnostics()} onRefresh={onRefresh} />,
      );
      await flushRender();
    });

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await flushRender();
    });

    await act(async () => {
      Array.from(document.body.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Actualiser'))
        ?.dispatchEvent(new Event('pointerdown', { bubbles: true, cancelable: true }));
      await flushRender();
    });

    expect(document.body.textContent).toContain('Payload');
  });

  it('keeps the circular control on the primary color across status tones', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({ phase: 'degraded', usableRatio: 0.94 })}
        />,
      );
      await flushRender();
    });

    const button = document.body.querySelector<HTMLButtonElement>(
      '[aria-label="Diagnostic du contexte"]',
    );
    expect(button?.getAttribute('class')).toContain('text-primary');
    expect(button?.getAttribute('class')).not.toContain('text-amber');

    await act(async () => {
      button?.click();
      await flushRender();
    });

    expect(button?.getAttribute('class')).toContain('border-primary/50');
    expect(button?.getAttribute('class')).toContain('bg-primary/10');

    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({ status: 'error', phase: 'provider_error' })}
        />,
      );
      await flushRender();
    });

    expect(button?.getAttribute('class')).toContain('text-primary');
    expect(button?.getAttribute('class')).not.toContain('text-destructive');
  });

  it('keeps previous metrics visible while a refresh is estimating', async () => {
    await act(async () => {
      root?.render(<ContextWindowIndicator diagnostics={buildDiagnostics()} />);
      await flushRender();
    });

    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[aria-label="Diagnostic du contexte"]')
        ?.click();
      await flushRender();
    });

    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({
            status: 'estimating',
            footprintBefore: undefined,
            footprintAfter: undefined,
            ratio: 0,
            usableRatio: 0,
          })}
        />,
      );
      await flushRender();
    });

    expect(document.body.textContent).toContain('82%');
    expect(document.body.textContent).toContain('42 messages · 6 sources');
    expect(document.body.querySelector('[data-testid="context-window-refreshing"]')).toBeNull();
  });

  it('keeps manual compaction available below the automatic threshold', async () => {
    const onCompactNow = mock(() => undefined);
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({
            phase: 'idle',
            ratio: 0.18,
            usableRatio: 0.22,
            footprintBefore: undefined,
            footprintAfter: {
              ...buildDiagnostics().footprintAfter!,
              totalEstimatedTokens: 20_000,
              serializedPayloadTokens: 18_000,
              totalContextRatio: 0.18,
              usableContextRatio: 0.22,
              threshold: 'none',
              reason: 'below_threshold',
              isHardStop: false,
            },
          })}
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

    const compactButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Compacter maintenant'),
    );
    expect(compactButton?.disabled).toBe(false);

    await act(async () => {
      compactButton?.click();
      await flushRender();
    });

    expect(onCompactNow).toHaveBeenCalled();
  });

  it('can disable manual compaction while keeping the low-threshold action visible', async () => {
    const onCompactNow = mock(() => undefined);
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({
            phase: 'idle',
            ratio: 0.18,
            usableRatio: 0.22,
            footprintBefore: undefined,
            footprintAfter: {
              ...buildDiagnostics().footprintAfter!,
              totalEstimatedTokens: 20_000,
              serializedPayloadTokens: 18_000,
              totalContextRatio: 0.18,
              usableContextRatio: 0.22,
              threshold: 'none',
              reason: 'below_threshold',
              isHardStop: false,
            },
          })}
          canCompactNow={false}
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

    const compactButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Compacter maintenant'),
    );
    expect(compactButton).not.toBeNull();
    expect(compactButton?.disabled).toBe(true);

    await act(async () => {
      compactButton?.click();
      await flushRender();
    });

    expect(onCompactNow).not.toHaveBeenCalled();
  });

  it('applies the target ratio immediately when reduced motion is requested', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: mock(() => ({
        matches: true,
        media: '(prefers-reduced-motion: reduce)',
        onchange: null,
        addListener: mock(() => undefined),
        removeListener: mock(() => undefined),
        addEventListener: mock(() => undefined),
        removeEventListener: mock(() => undefined),
        dispatchEvent: mock(() => false),
      })),
    });

    await act(async () => {
      root?.render(
        <ContextWindowIndicator diagnostics={buildDiagnostics({ usableRatio: 0.1 })} />,
      );
      await flushRender();
    });

    await act(async () => {
      root?.render(
        <ContextWindowIndicator diagnostics={buildDiagnostics({ usableRatio: 0.64 })} />,
      );
      await flushRender();
    });

    expect(
      document.body
        .querySelector('[data-testid="context-window-fill"]')
        ?.getAttribute('stroke-dasharray'),
    ).toBe('64 100');
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
