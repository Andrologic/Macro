import { describe, expect, it } from 'bun:test';
import { matchesLocalSearchQuery, normalizeLocalSearchText } from './localModeSearch';

describe('local mode search', () => {
  it('normalizes case and accents predictably', () => {
    expect(normalizeLocalSearchText('ÉTÉ')).toBe('ete');
    expect(matchesLocalSearchQuery('deploiement', ['Déploiement local'])).toBe(true);
  });

  it('matches every item for an empty query', () => {
    expect(matchesLocalSearchQuery('   ', ['Any title'])).toBe(true);
  });

  it('does not match unrelated values', () => {
    expect(matchesLocalSearchQuery('release', ['Bug triage', null])).toBe(false);
  });
});
