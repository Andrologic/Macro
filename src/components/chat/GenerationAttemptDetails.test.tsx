import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../i18n';
import { GenerationAttemptDetails } from './GenerationAttemptDetails';

describe('GenerationAttemptDetails', () => {
  it('keeps abandoned text inspectable without presenting an unknown cost as zero', () => {
    const html = renderToStaticMarkup(<GenerationAttemptDetails attempts={[
      { id: 'first', status: 'abandoned', rawText: 'discarded draft', acceptedText: '', costUsd: null },
      { id: 'second', status: 'completed', rawText: 'final answer', acceptedText: 'final answer', costUsd: null },
    ]} />);
    expect(html).toContain('data-attempt-id="first"');
    expect(html).toContain('discarded draft');
    expect(html).toContain('cost unknown');
    expect(html).not.toContain('$0');
  });
});
