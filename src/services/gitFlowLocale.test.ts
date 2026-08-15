import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko'];

const readJson = (path: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(process.cwd(), path), 'utf8'));

describe('GitFlow type labels', () => {
  it('uses canonical Feature, Bugfix, and Hotfix terms across Architect and Implement', () => {
    for (const locale of LOCALES) {
      const base = readJson(`src/i18n/locales/${locale}.json`);
      const implement = readJson(`src/i18n/locales/segments/implement-${locale}.json`);
      const architect = base.architect as Record<string, Record<string, string>>;

      for (const kind of ['Feature', 'Bugfix', 'Hotfix']) {
        expect(architect.planSelector[`kind${kind}`], `${locale} Architect ${kind}`).toBe(kind);
        expect(implement[`taskKind${kind}`], `${locale} Implement ${kind}`).toBe(kind);
        expect(implement[`manual${kind}Untitled`], `${locale} default ${kind} name`).toContain(kind);
        expect(implement[`taskKind${kind}Help`], `${locale} ${kind} help`).toContain(kind);
      }
      expect(architect.planSelector.kindRelease, `${locale} Architect Release`).toBe('Release');
      expect(architect.planSelector.kindReleaseHelp, `${locale} Architect Release help`).toBeTruthy();
    }
  });
});
