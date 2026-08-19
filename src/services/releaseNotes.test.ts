import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  getReleaseNote,
  normalizeSeenReleaseNoteVersions,
  shouldShowReleaseNote,
} from './releaseNotes';

describe('release notes', () => {
  it('ships a note for the current application version', () => {
    const packageJson = JSON.parse(
      readFileSync(resolve(import.meta.dir, '../../package.json'), 'utf8'),
    ) as { version: string };

    expect(getReleaseNote(packageJson.version, 'en')).not.toBeNull();
  });

  it('selects French content and falls back to English for other locales', () => {
    expect(getReleaseNote('0.1.0', 'fr-FR')?.title).toBe('Macro 0.1 est prêt');
    expect(getReleaseNote('0.1.0', 'de-DE')?.title).toBe('Macro 0.1 is ready');
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
});
