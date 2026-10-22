import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../i18n';
import { GenerationAttemptDetails } from './GenerationAttemptDetails';

describe('GenerationAttemptDetails', () => {
  it('shows a single attempt as a plain message without disclosing the provider payload', () => {
    const html = renderToStaticMarkup(<GenerationAttemptDetails attempts={[
      { id: 'only-turn', status: 'completed', rawText: 'Provider draft.', acceptedText: 'Answer.', costUsd: null },
    ]} />);
    expect(html).toContain('1 generation attempt');
    expect(html).not.toContain('<details');
    expect(html).not.toContain('<summary');
    expect(html).not.toContain('only-turn');
    expect(html).not.toContain('Provider draft.');
    expect(html).not.toContain('Answer.');
  });

  it('counts completed, partial and abandoned attempts without duplicating the response', () => {
    const html = renderToStaticMarkup(<GenerationAttemptDetails attempts={[
      { id: 'first', status: 'abandoned', rawText: 'discarded draft', acceptedText: '', costUsd: null },
      { id: 'second', status: 'partial', rawText: 'partial draft', acceptedText: 'partial', costUsd: null },
      { id: 'third', status: 'completed', rawText: 'final answer', acceptedText: 'final answer', costUsd: 0.01 },
    ]} />);
    expect(html).toContain('3 generation attempts');
    expect(html).not.toContain('final answer');
    expect(html).not.toContain('discarded draft');
  });

  it('omits the message before any generation attempt exists', () => {
    expect(renderToStaticMarkup(<GenerationAttemptDetails />)).toBe('');
    expect(renderToStaticMarkup(<GenerationAttemptDetails attempts={[]} />)).toBe('');
  });
});
