import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');
const INCLUDED_DIRECTORIES = new Set(['components', 'stores', 'services']);
const IGNORED_DIRECTORY_NAMES = new Set([
  'i18n',
  'contracts',
  'providers',
]);
const IGNORED_FILE_SUFFIXES = new Set(['projectRegistry.ts']);
const STRING_LITERAL_PATTERN = /(['"`])((?:\\.|(?!\1).)*?)\1/g;
const TRANSLATION_MARKER = 't' + '(';
const I18N_TRANSLATION_MARKER = 'i18n' + '.t' + '(';
const SUSPICIOUS_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /\breparee?s?\b/iu, replacement: 'réparé / réparée' },
  { pattern: /\bselection\b/iu, replacement: 'sélection' },
  { pattern: /\breferences\b/iu, replacement: 'références' },
  { pattern: /\bnettoyee?s?\b/iu, replacement: 'nettoyée / nettoyées' },
  { pattern: /\bcree(?:e|es|s)?\b/iu, replacement: 'créé / créée' },
  { pattern: /\bechoue(?:e|es|s)?\b/iu, replacement: 'échoué / échouée' },
  { pattern: /\bdeja\b/iu, replacement: 'déjà' },
  { pattern: /\betre\b/iu, replacement: 'être' },
];

const isTechnicalCssLiteral = (literal: string): boolean => {
  if (!literal.trim()) {
    return false;
  }

  return (
    literal.startsWith('--') ||
    literal.includes('.cm-') ||
    literal.includes('::') ||
    literal.includes('&.') ||
    literal.includes('>.') ||
    literal.includes(' .cm-')
  );
};

const collectSourceFiles = (directory: string): string[] => {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory === SRC_ROOT && !INCLUDED_DIRECTORIES.has(entry.name)) {
        return [];
      }
      if (IGNORED_DIRECTORY_NAMES.has(entry.name)) {
        return [];
      }
      return collectSourceFiles(fullPath);
    }

    if (!entry.isFile()) {
      return [];
    }

    if (!/\.(ts|tsx)$/.test(entry.name) || /\.test\.(ts|tsx)$/.test(entry.name)) {
      return [];
    }
    if (IGNORED_FILE_SUFFIXES.has(entry.name)) {
      return [];
    }

    return [fullPath];
  });
};

describe('french hardcoded copy', () => {
  it('does not contain common French accent omissions in user-facing strings', () => {
    const files = collectSourceFiles(SRC_ROOT);
    const findings: string[] = [];

    for (const filePath of files) {
      const stats = statSync(filePath);
      if (!stats.isFile()) continue;

      const content = readFileSync(filePath, 'utf8');
      const lines = content.split('\n');
      for (const [lineIndex, line] of lines.entries()) {
        if (!line.includes("'") && !line.includes('"') && !line.includes('`')) {
          continue;
        }
        if (
          line.includes('defaultValue') ||
          line.includes(TRANSLATION_MARKER) ||
          line.includes(I18N_TRANSLATION_MARKER) ||
          line.includes('getRegistryTranslation(')
        ) {
          continue;
        }

        for (const match of line.matchAll(STRING_LITERAL_PATTERN)) {
          const literal = match[2];
          if (!literal || !/[A-Za-z]/.test(literal)) {
            continue;
          }
          if (isTechnicalCssLiteral(literal)) {
            continue;
          }

          for (const { pattern, replacement } of SUSPICIOUS_PATTERNS) {
            if (!pattern.test(literal)) {
              continue;
            }

            findings.push(
              `${filePath}:${lineIndex + 1} -> "${literal}" should use ${replacement}`
            );
            break;
          }
        }
      }
    }

    expect(findings).toEqual([]);
  });
});
