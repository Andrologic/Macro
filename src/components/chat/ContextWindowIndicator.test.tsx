import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import type {
  ConversationCompactionStatus,
  ConversationContextDiagnostics,
  ManualCompactionResult,
} from '../../stores/useChatStore';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';

installReactI18nextMock(createTranslationMock({
  'chat.contextWindow.ariaLabel': 'Diagnostic du contexte',
  'chat.contextWindow.titleWithPercent': '{{label}} · {{percent}} du budget utile',
  'chat.contextWindow.status.window': 'Fenêtre de contexte',
  'chat.contextWindow.status.error': 'Erreur contexte',
  'chat.contextWindow.status.compactionRequired': 'Compaction nécessaire',
  'chat.contextWindow.status.compacting': 'Compactage en cours',
  'chat.contextWindow.status.tooLarge': 'Contexte trop volumineux',
  'chat.contextWindow.status.reduced': 'Contexte réduit',
  'chat.contextWindow.status.nearlyFull': 'Fenêtre presque pleine',
  'chat.contextWindow.providerFallback': 'Provider',
  'chat.contextWindow.modelFallback': 'Modèle non sélectionné',
  'chat.contextWindow.usefulBudgetShort': 'budget utile',
  'chat.contextWindow.none': 'Aucun',
  'chat.contextWindow.disabled.diagnosticsError': 'Diagnostics en erreur',
  'chat.contextWindow.disabled.unavailable': 'Action non disponible',
  'chat.contextWindow.compactButton.none': 'Rien à compacter',
  'chat.contextWindow.compactButton.aggressive': 'Compacter plus agressivement',
  'chat.contextWindow.compactButton.default': 'Compacter maintenant',
  'chat.contextWindow.metrics.payload': 'Payload',
  'chat.contextWindow.metrics.modelLimit': 'Limite modèle',
  'chat.contextWindow.metrics.estimatedLimit': 'Limite estimée',
  'chat.contextWindow.metrics.usefulBudget': 'Budget utile',
  'chat.contextWindow.metrics.margin': 'Marge',
  'chat.contextWindow.metrics.limitSource': 'Source limite',
  'chat.contextWindow.metrics.confidence': 'Confiance',
  'chat.contextWindow.metrics.totalContext': 'Contexte total',
  'chat.contextWindow.metrics.checkpoint': 'Checkpoint',
  'chat.contextWindow.limitSource.userOverride': 'Override utilisateur',
  'chat.contextWindow.limitSource.providerMetadata': 'Provider',
  'chat.contextWindow.limitSource.modelMetadata': 'Modèle',
  'chat.contextWindow.limitSource.providerOverflowError': 'Erreur provider',
  'chat.contextWindow.limitSource.macroFallback': 'Fallback Macro',
  'chat.contextWindow.limitSource.unknown': 'Inconnue',
  'chat.contextWindow.confidence.configured': 'Configurée',
  'chat.contextWindow.confidence.verified': 'Vérifiée',
  'chat.contextWindow.confidence.catalog': 'Catalogue',
  'chat.contextWindow.confidence.learned': 'Apprise',
  'chat.contextWindow.confidence.low': 'Faible',
  'chat.contextWindow.confidence.standard': 'Standard',
  'chat.contextWindow.warning.estimatedLimit': "Cette limite n'est pas autoritaire; Macro ne déclenche pas de compaction automatique uniquement sur cette valeur.",
  'chat.contextWindow.warning.providerOverflow': "Cette limite vient d'une erreur provider et pourra être remplacée par une métadonnée plus fraîche.",
  'chat.contextWindow.warning.modelWindowShrank': 'Le modèle sélectionné a une fenêtre plus petite que le dernier checkpoint connu.',
  'chat.contextWindow.manual.action': 'Action manuelle',
  'chat.contextWindow.manual.latestResult': 'Dernier résultat',
  'chat.contextWindow.manual.feedback.compactedLabel': 'Checkpoint créé',
  'chat.contextWindow.manual.feedback.notEnoughHistoryLabel': 'Rien à compacter',
  'chat.contextWindow.manual.feedback.alreadyCurrentLabel': 'Checkpoint à jour',
  'chat.contextWindow.manual.feedback.skippedLabel': 'Compactage ignoré',
  'chat.contextWindow.manual.feedback.compactedDetail': '{{tokens}} tokens économisés',
  'chat.contextWindow.manual.feedback.notEnoughHistoryDetail': '{{userTurns}} tours utilisateur, {{retainedTurns}} conservés',
  'chat.contextWindow.manual.feedback.alreadyCurrentDetail': 'Le checkpoint existant couvre déjà la frontière actuelle',
  'chat.contextWindow.manual.feedback.notBeneficialDetail': "Le résumé n'aurait pas réduit le payload",
  'chat.contextWindow.manual.feedback.belowThresholdDetail': 'Le contexte est sous le seuil de compactage utile',
  'chat.contextWindow.compaction': 'Compaction',
  'chat.contextWindow.countSummary': '{{messages}} messages · {{sources}} sources',
  'chat.contextWindow.refresh': 'Actualiser',
}));

const { ContextWindowIndicator } = await import('./ContextWindowIndicator');

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
  contextLimitSource: 'provider_metadata',
  isContextLimitAuthoritative: true,
  contextLimitConfidence: 'verified',
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
    contextLimitSource: 'provider_metadata',
    isContextLimitAuthoritative: true,
    contextLimitConfidence: 'verified',
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
    contextLimitSource: 'provider_metadata',
    isContextLimitAuthoritative: true,
    contextLimitConfidence: 'verified',
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

const buildCompactionStatus = (
  overrides: Partial<ConversationCompactionStatus> = {},
): ConversationCompactionStatus => ({
  phase: 'safety_compacting',
  updatedAt: '2026-05-10T00:01:00.000Z',
  kind: 'safety_prestream',
  footprintAfter: {
    ...buildDiagnostics().footprintAfter!,
    usableContextRatio: 0.42,
    totalContextRatio: 0.5,
  },
  ...overrides,
});

const buildManualFeedback = (
  overrides: Partial<ManualCompactionResult> = {},
): ManualCompactionResult => ({
  outcome: 'compacted',
  updatedAt: '2026-05-10T00:02:00.000Z',
  footprintBefore: buildDiagnostics().footprintBefore!,
  footprintAfter: buildDiagnostics().footprintAfter!,
  tokensSaved: 24_000,
  upToMessageId: 'a1',
  summarySource: 'model',
  ...overrides,
} as ManualCompactionResult);

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

  it('shows a compacting wave clipped to the active context fill', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator diagnostics={buildDiagnostics()} isCompacting />
      );
      await flushRender();
    });

    expect(document.body.querySelector('[data-testid="context-window-compacting"]')).not.toBeNull();
    const spinner = document.body.querySelector(
      '[data-testid="context-window-compacting-spinner"]',
    );
    expect(spinner).not.toBeNull();
    expect(spinner?.getAttribute('role')).toBe('status');
    const compactionWave = document.body.querySelector(
      '[data-testid="context-window-compacting"]',
    );
    const compactionMask = document.body.querySelector(
      '[data-testid="context-window-compacting-mask-fill"]',
    );
    expect(compactionWave).not.toBeNull();
    expect(compactionMask).not.toBeNull();
    expect(compactionMask?.getAttribute('stroke-dasharray')).toBe('82 100');
    expect(compactionWave?.getAttribute('stroke-dasharray')).toBe('18 100');
    expect(compactionWave?.getAttribute('mask')).toContain('context-window-compacting-mask');
    expect(
      compactionWave?.getAttribute('class'),
    ).toContain('context-window-compaction-wave');
    expect(compactionWave?.getAttribute('class')).not.toContain('animate-spin');
    expect(document.body.querySelector('svg')?.getAttribute('class')).not.toContain(
      'animate-spin',
    );
  });

  it('keeps the compacting wave inside small active context windows', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({ usableRatio: 0.1 })}
          isCompacting
        />,
      );
      await flushRender();
    });

    const compactionWave = document.body.querySelector(
      '[data-testid="context-window-compacting"]',
    );
    const compactionMask = document.body.querySelector(
      '[data-testid="context-window-compacting-mask-fill"]',
    );

    expect(compactionMask?.getAttribute('stroke-dasharray')).toBe('10 100');
    expect(Number(compactionWave?.getAttribute('stroke-dasharray')?.split(' ')[0])).toBeLessThanOrEqual(10);
  });

  it('uses the runtime compaction footprint when diagnostics are not available yet', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          isCompacting
          compactionStatus={buildCompactionStatus()}
        />,
      );
      await flushRender();
    });

    expect(
      document.body
        .querySelector('[data-testid="context-window-fill"]')
        ?.getAttribute('stroke-dasharray'),
    ).toBe('42 100');
    expect(
      document.body
        .querySelector('[data-testid="context-window-compacting-mask-fill"]')
        ?.getAttribute('stroke-dasharray'),
    ).toBe('42 100');
    expect(document.body.querySelector('[data-testid="context-window-compacting"]')).not.toBeNull();
  });

  it('keeps the compacting status without drawing a wave when no footprint is known', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          isCompacting
          compactionStatus={buildCompactionStatus({ footprintAfter: undefined })}
        />,
      );
      await flushRender();
    });

    expect(document.body.querySelector('[data-testid="context-window-compacting"]')).toBeNull();
    expect(
      document.body.querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
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

    expect(document.body.textContent).toContain('Compactage en cours');
  });

  it('shows the manual preflight label while analyzing context', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics()}
          isCompacting
          activityLabel="Analyse du contexte..."
          onCompactNow={() => undefined}
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

    expect(document.body.textContent).toContain('Analyse du contexte...');
    expect(
      document.body.querySelector('[data-testid="context-window-compacting-spinner"]'),
    ).not.toBeNull();
  });

  it('does not show a live measurement label in the popover', async () => {
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

    expect(document.body.textContent).not.toContain('Mesure en direct');
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

  it('does not reuse previous metrics for an estimating diagnostic from another conversation', async () => {
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
            conversationId: 'conv-2',
            footprintBefore: undefined,
            footprintAfter: undefined,
            ratio: 0,
            usableRatio: 0,
            counts: {
              messages: 0,
              visibleLines: 0,
              hiddenContextLines: 0,
              providerInputItems: 0,
              providerInputItemLines: 0,
              reasoningContentLines: 0,
              toolResultLines: 0,
              citations: 0,
              activeFiles: 0,
              toolFacts: 0,
            },
          })}
        />,
      );
      await flushRender();
    });

    expect(document.body.textContent).toContain('Fenêtre de contexte');
    expect(document.body.textContent).toContain('0 messages · 0 sources');
    expect(document.body.textContent).not.toContain('42 messages · 6 sources');
  });

  it('uses a neutral label for ready and compacted states', async () => {
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

    expect(document.body.textContent).toContain('Fenêtre de contexte');
    expect(document.body.textContent).not.toContain('Contexte compacté');
    expect(document.body.textContent).not.toContain('Contexte disponible');

    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({
            phase: 'idle',
            footprintBefore: undefined,
          })}
        />,
      );
      await flushRender();
    });

    expect(document.body.textContent).toContain('Fenêtre de contexte');
    expect(document.body.textContent).not.toContain('Contexte compacté');
    expect(document.body.textContent).not.toContain('Contexte disponible');
  });

  it('does not reuse previous metrics for an estimating diagnostic from another model', async () => {
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
            modelId: 'other-model',
            footprintBefore: undefined,
            footprintAfter: undefined,
            ratio: 0,
            usableRatio: 0,
            counts: {
              messages: 1,
              visibleLines: 0,
              hiddenContextLines: 0,
              providerInputItems: 0,
              providerInputItemLines: 0,
              reasoningContentLines: 0,
              toolResultLines: 0,
              citations: 0,
              activeFiles: 0,
              toolFacts: 0,
            },
          })}
        />,
      );
      await flushRender();
    });

    expect(document.body.textContent).toContain('1 messages · 0 sources');
    expect(document.body.textContent).not.toContain('42 messages · 6 sources');
  });

  it('greys manual compaction below the automatic threshold', async () => {
    const onCompactNow = mock(() => undefined);
    const disabledReason = 'Le contexte est trop léger pour un compactage utile.';
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
          manualCompactionDisabledReason={disabledReason}
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
      (button) => button.textContent?.includes('Rien à compacter'),
    );
    expect(compactButton).not.toBeNull();
    expect(compactButton?.disabled).toBe(true);
    expect(compactButton?.getAttribute('title')).toBe(disabledReason);
    expect(document.body.textContent).toContain('Action manuelle');
    expect(document.body.textContent).toContain(disabledReason);

    await act(async () => {
      compactButton?.click();
      await flushRender();
    });

    expect(onCompactNow).not.toHaveBeenCalled();
  });

  it('shows the latest manual compaction feedback in the popover', async () => {
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics()}
          manualCompactionFeedback={buildManualFeedback()}
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

    expect(document.body.textContent).toContain('Dernier résultat');
    expect(document.body.textContent).toContain('Checkpoint créé');
    expect(document.body.textContent).toContain('24k tokens économisés');
  });

  it('keeps the below-threshold action greyed while showing a skipped result', async () => {
    const onCompactNow = mock(() => undefined);
    const disabledReason = 'Le contexte est trop léger pour un compactage utile.';
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
          manualCompactionFeedback={buildManualFeedback({
            outcome: 'skipped',
            reason: 'below_threshold',
            userTurnCount: 3,
            retainedTurnCount: 2,
          } as Partial<ManualCompactionResult>)}
          manualCompactionDisabledReason={disabledReason}
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

    expect(document.body.textContent).toContain('Compactage ignoré');
    expect(document.body.textContent).toContain('sous le seuil');
    expect(document.body.textContent).toContain(disabledReason);
    const compactButton = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Rien à compacter'),
    );
    expect(compactButton?.disabled).toBe(true);
    expect(onCompactNow).not.toHaveBeenCalled();
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
    expect(document.body.textContent).toContain('Limite modèle');
    expect(document.body.textContent).toContain('Budget utile');
    expect(document.body.textContent).not.toContain('Réserve sortie');
    expect(document.body.textContent).not.toContain('reserved');
    expect(document.body.textContent).not.toContain('reserve');
    expect(document.body.textContent).toContain('Marge');
    expect(document.body.textContent).toContain('Source limite');
    expect(document.body.textContent).toContain('Provider');
    expect(document.body.textContent).toContain('Vérifiée');
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

  it('labels fallback context windows as estimated limits', async () => {
    const base = buildDiagnostics();
    await act(async () => {
      root?.render(
        <ContextWindowIndicator
          diagnostics={buildDiagnostics({
            isContextLimitAuthoritative: false,
            contextLimitSource: 'macro_fallback',
            contextLimitConfidence: 'fallback',
            contextLimitWarning: 'Limite estimée par Macro.',
            footprintAfter: {
              ...base.footprintAfter!,
              contextLimitSource: 'macro_fallback',
              isContextLimitAuthoritative: false,
              contextLimitConfidence: 'fallback',
              contextLimitWarning: 'Limite estimée par Macro.',
            },
          })}
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

    expect(document.body.textContent).toContain('Limite estimée');
    expect(document.body.textContent).toContain('Fallback Macro');
    expect(document.body.textContent).toContain('Limite estimée par Macro.');
    expect(document.body.textContent).not.toContain('Limite modèle');
  });
});
