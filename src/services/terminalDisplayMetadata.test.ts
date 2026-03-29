import { describe, expect, it } from 'bun:test';
import { buildTerminalDisplayMetadata } from './terminalDisplayMetadata';

describe('buildTerminalDisplayMetadata', () => {
  it('keeps the full UI title while the prompt context stays compact', () => {
    const metadata = buildTerminalDisplayMetadata({
      projectLabel: 'cascade',
      taskLabel: 'Refactor Application Parser Logic With Very Long User Facing Title',
    });

    expect(metadata.title).toBe(
      'cascade - Refactor Application Parser Logic With Very Long User Facing Title'
    );
    expect(metadata.promptContext).toEqual({
      projectLabel: 'cascade',
      taskLabel: 'Refactor Applicatio... Title',
      branchLabel: null,
    });
  });

  it('sanitizes title segments without truncating them', () => {
    const metadata = buildTerminalDisplayMetadata({
      projectLabel: '  cascade  ',
      taskLabel: 'Parser\tlogic | cleanup\r\npass',
      instanceIndex: 2,
    });

    expect(metadata.title).toBe('cascade - Parser logic cleanup pass #2');
    expect(metadata.promptContext).toEqual({
      projectLabel: 'cascade',
      taskLabel: 'Parser logic cleanup pass',
      branchLabel: null,
    });
  });
});
