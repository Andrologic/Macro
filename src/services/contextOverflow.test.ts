import { describe, expect, it } from 'bun:test';

import {
  extractContextLimitTokensFromErrorLike,
  extractContextLimitTokensFromMessage,
  isContextOverflowMessage,
} from './contextOverflow';

describe('contextOverflow', () => {
  it('classifies known provider overflow messages', () => {
    expect(
      isContextOverflowMessage(
        'input token count 120000 exceeds the maximum of 64000',
        400,
      ),
    ).toBe(true);
  });

  it('extracts numeric context limits from provider messages', () => {
    expect(
      extractContextLimitTokensFromMessage(
        'input token count 120000 exceeds the maximum of 64000',
      ),
    ).toBe(64_000);
    expect(
      extractContextLimitTokensFromMessage(
        'maximum context length is 128,000 tokens',
      ),
    ).toBe(128_000);
    expect(
      extractContextLimitTokensFromErrorLike({
        providerMessage: 'context length is only 200000 tokens',
      }),
    ).toBe(200_000);
  });
});
