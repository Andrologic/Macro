import { describe, expect, it } from 'bun:test';

import { buildModelContextAuditRows } from './modelContextAudit';

describe('modelContextAudit', () => {
  it('lists resolved context limits with source confidence and warnings', () => {
    const rows = buildModelContextAuditRows({
      providerConfigs: [
        {
          id: 'provider-1',
          providerType: 'openai',
          baseUrl: 'https://api.openai.com/v1',
        },
      ],
      modelsByProvider: {
        'provider-1': [
          {
            id: 'model-a',
            name: 'Model A',
            provider_id: 'provider-1',
            contextWindowTokens: 200_000,
            contextWindowSource: 'provider_metadata',
            inputLimitTokens: 180_000,
          },
          {
            id: 'model-b',
            name: 'Model B',
            provider_id: 'provider-1',
          },
        ],
      },
    });

    expect(rows[0]).toMatchObject({
      providerId: 'provider-1',
      modelId: 'model-a',
      contextTokens: 200_000,
      inputTokens: 180_000,
      source: 'provider_metadata',
      isAuthoritative: true,
      confidence: 'verified',
    });
    expect(rows[1]).toMatchObject({
      providerId: 'provider-1',
      modelId: 'model-b',
      source: 'macro_fallback',
      isAuthoritative: false,
      confidence: 'fallback',
    });
    expect(rows[1]?.warning).toContain('Limite estimée par Macro');
  });
});
