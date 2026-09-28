import { describe, expect, it } from 'bun:test';
import { renderToStaticMarkup } from 'react-dom/server';
import '../../i18n';
import { GenerationAttemptDetails } from './GenerationAttemptDetails';

describe('GenerationAttemptDetails', () => {
  it('shows separate completed provider turns even when neither text was discarded', () => {
    const html = renderToStaticMarkup(<GenerationAttemptDetails attempts={[
      { id: 'tool-turn', status: 'completed', rawText: 'Reading.', acceptedText: 'Reading.', costUsd: null },
      { id: 'answer-turn', status: 'completed', rawText: 'Answer.', acceptedText: 'Answer.', costUsd: null },
    ]} />);
    expect(html).toContain('data-attempt-id="tool-turn"');
    expect(html).toContain('data-attempt-id="answer-turn"');
    expect(html.match(/data-attempt-status="completed"/g)).toHaveLength(2);
    expect(html.match(/Attempt text:/g)).toHaveLength(2);
    expect(html).toContain('Reading.');
    expect(html).toContain('Answer.');
  });

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
