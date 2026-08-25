import { describe, expect, it } from 'bun:test';
import {
  getReleaseNote,
  normalizePendingUpdateReleaseNote,
  normalizeSeenReleaseNoteVersions,
  resolveReleaseNote,
  shouldShowReleaseNote,
} from './releaseNotes';

describe('release notes', () => {
  it('ships a bootstrap note for the first updater-capable version', () => {
    expect(getReleaseNote('0.1.0', 'en')).not.toBeNull();
  });

  it('selects French content and falls back to English for other locales', () => {
    expect(getReleaseNote('0.1.0', 'fr-FR')?.title).toBe('Macro 0.1 est prêt');
    expect(getReleaseNote('0.1.0', 'de-DE')?.title).toBe('Macro 0.1 is ready');
    expect(getReleaseNote('0.1.0', 'fr-FR')?.content).toContain(
      '## Tout le travail au même endroit',
    );
  });

  it('normalizes persisted versions and only shows unseen notes', () => {
    const seenVersions = normalizeSeenReleaseNoteVersions([
      '0.0.9',
      '0.0.9',
      '',
      null,
      1,
    ]);
    const note = getReleaseNote('0.1.0', 'en');

    expect(seenVersions).toEqual(['0.0.9']);
    expect(shouldShowReleaseNote(note, seenVersions)).toBe(true);
    expect(shouldShowReleaseNote(note, [...seenVersions, '0.1.0'])).toBe(false);
    expect(shouldShowReleaseNote(null, seenVersions)).toBe(false);
  });

  it('uses persisted updater notes for the installed version', () => {
    const note = resolveReleaseNote('0.2.0', 'de-DE', {
      version: '0.2.0',
      content: '## Changes\n\n![Preview](https://example.com/preview.png)',
    });

    expect(note).toEqual({
      version: '0.2.0',
      eyebrow: '',
      title: 'Macro 0.2.0',
      summary: '',
      content: '## Changes\n\n![Preview](https://example.com/preview.png)',
    });
    expect(resolveReleaseNote('0.2.1', 'en', {
      version: '0.2.0',
      content: 'stale',
    })).toBeNull();
  });

  it('rejects malformed pending updater notes', () => {
    expect(normalizePendingUpdateReleaseNote(null)).toBeNull();
    expect(normalizePendingUpdateReleaseNote({ version: '0.2.0', content: '  ' })).toBeNull();
    expect(normalizePendingUpdateReleaseNote({ version: 2, content: 'Changes' })).toBeNull();
  });
});
