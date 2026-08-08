import { describe, expect, it } from 'bun:test';
import {
  rankSlashContextCandidates,
  scoreSlashContextCandidate,
} from './slashContextRanking';

const now = new Date('2026-05-27T12:00:00.000Z').getTime();

describe('slashContextRanking', () => {
  it('boosts files for path-like queries', () => {
    const fileScore = scoreSlashContextCandidate(
      {
        key: 'file:src/App.tsx',
        kind: 'file',
        title: 'src/App.tsx',
        searchText: 'src/App.tsx Web TypeScript',
        isFocusedFile: true,
      },
      { query: 'src/', mode: 'Implement', hasActivePlan: false, now },
    );
    const needScore = scoreSlashContextCandidate(
      {
        key: 'need:src',
        kind: 'need',
        title: 'Source review',
        searchText: 'Source review',
      },
      { query: 'src/', mode: 'Implement', hasActivePlan: false, now },
    );

    expect(fileScore).toBeGreaterThan(needScore);
  });

  it('boosts active-plan needs in Architect mode for non-file queries', () => {
    const ranked = rankSlashContextCandidates(
      [
        {
          key: 'skill:auth',
          kind: 'skill',
          title: 'auth',
          searchText: 'auth',
          skillEnabled: true,
        },
        {
          key: 'need:auth',
          kind: 'need',
          title: 'auth',
          searchText: 'auth',
        },
      ],
      { query: 'auth', mode: 'Architect', hasActivePlan: true, now },
    );

    expect(ranked[0]?.key).toBe('need:auth');
  });

  it('moves frequently used context upward', () => {
    const ranked = rankSlashContextCandidates(
      [
        {
          key: 'need:alpha',
          kind: 'need',
          title: 'alpha',
          searchText: 'alpha',
        },
        {
          key: 'skill:alpha',
          kind: 'skill',
          title: 'alpha',
          searchText: 'alpha',
          skillEnabled: true,
          useCount: 16,
          lastUsedAt: now,
        },
      ],
      { query: 'alpha', mode: 'Chat', hasActivePlan: false, now },
    );

    expect(ranked[0]?.key).toBe('skill:alpha');
  });

  it('ranks disabled skills below selectable matches', () => {
    const ranked = rankSlashContextCandidates(
      [
        {
          key: 'skill:test-disabled',
          kind: 'skill',
          title: 'test',
          searchText: 'test',
          disabled: true,
        },
        {
          key: 'skill:test-enabled',
          kind: 'skill',
          title: 'test',
          searchText: 'test',
          skillEnabled: true,
        },
      ],
      { query: 'test', mode: 'Chat', hasActivePlan: false, now },
    );

    expect(ranked[0]?.key).toBe('skill:test-enabled');
  });
});
