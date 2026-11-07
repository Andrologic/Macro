import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

const SRC_ROOT = join(process.cwd(), 'src');
const INCLUDED_DIRECTORIES = new Set(['components', 'stores', 'services']);
const IGNORED_DIRECTORY_NAMES = new Set([
  '__tests__',
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
const ENGLISH_GUIDE_LITERALS = [
  'Only an agent with instructs:true may submit instructions as another work mission. Those instructions become the outgoing default prompt or can be selected as prompt:{from:[instructions]}. A fan-out each:[instructions] expects a list of strings; each element is its path mission and prompt:{from:[item]} may select it. Plain agent results remain information. Submitted missions cannot override standing instructions or permissions. A join carries instructions as branch information; an explicit prompt selection may read [branches,branch,instructions]. A route expecting instructions requires a valid submission before routing.',
  'compositions maps names to {parameters?,entry,steps,outputs,title?,description?}. parameters names agents. compose step has composition, agents mapping exactly those parameters, next mapping exactly the outputs, optional onError. Body agent references may be names or {parameter:name}; nested compose agents may forward {parameter:name}. Body routes leave via {output:name}, with no message; the calling compose output route carries the message and selects the exiting body step output. Every output is used. Body forks must close in one join. Nested compositions are allowed, cyclic composition references are invalid. Expanded step paths are lists of caller/body step names; source pointers remain /compositions/name/steps/name. One composition work leaves at most once, through an output or failure.',
  'message:{prompt?,resources?} separates mission and information. prompt is a string, ordered Sources or a permitted instruction selection. Resource selections use {from:[keysOrIndices],mediaType?} into the previous output, never the 0.2 select/source forms. Explicit message replaces the entire default, so copy every needed resource explicitly. Default agent message contains resources.text plus accepted results; it has a prompt only for instructs:true. Default call message has resources.result=data. Default join message has one resource per branch. Approval passes on its input and accumulated comments. Compose uses the default message of the exiting body step. Error routes supply resources.error. Calls and joins accept no message. Prompt precedence is explicit route prompt, then default-message prompt, then step.prompt. If only some routes bring a prompt, the target agent step must supply a fallback prompt.',
];
const TECHNICAL_LITERAL_ALLOWLIST = new Set([
  ...ENGLISH_GUIDE_LITERALS,
  'skip-dom-selection',
  'skip-selection-focus',
  // These exact English provider errors do not contain French accent omissions.
  'Goal auditor provider selection conflicts with its authorization.',
  'Invalid goal auditor provider selection.',
  'Runtime selection owner differs from the conversation',
  'Runtime selection owner or draft changed before acceptance',
  'Only one AgSDL selection may be sent.',
  'Invalid runtime selection',
  'Runtime selection destination differs',
  'Selection path must be a list.',
  'Missing selection property.',
  'Selection container does not match its path.',
  'Prompt selection requires authorized instructions.',
  'Invalid selection segment.',
  'Invalid selection index.',
  'Invalid prompt selection.',
  'Invalid resource selection.',
  '${selectionBlocks().source}' + String.raw`(?:\\r?\\n(?:Use agsdl_get|This AgSDL selection)[^\\r\\n]*)?`,
]);
// These English protocol instructions contain words shared with French.
const ENGLISH_PROTOCOL_PREFIXES = [
  'A source has exactly value or uri,',
  'A Join requires an existing direct fork',
  'An Approval requires an existing protected Call',
  'This AgSDL selection is an immutable historical runtime capture.',
];

const isAllowedTechnicalLiteral = (literal: string): boolean =>
  TECHNICAL_LITERAL_ALLOWLIST.has(literal) || ENGLISH_PROTOCOL_PREFIXES.some(prefix => literal.startsWith(prefix));

// A kind comparison uses a tagged union identifier rather than user-facing copy.
const isKindComparison = (prefix: string): boolean => /\.kind\s*(?:===|!==)\s*$/.test(prefix);

const isPropertyName = (prefix: string, suffix: string): boolean =>
  (/[\w$.)\]]\s*\[\s*$/.test(prefix) && /^\s*\]/.test(suffix)) ||
  (/(?:^|[,{;])\s*$/.test(prefix) && /^\s*\??\s*:/.test(suffix));

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
  it('checks French text appended to the three English guide instructions', () => {
    for (const literal of ENGLISH_GUIDE_LITERALS) {
      expect(isAllowedTechnicalLiteral(literal)).toBe(true);
      const extended = `${literal} selection deja echouee`;
      expect(SUSPICIOUS_PATTERNS.some(({ pattern }) => pattern.test(extended))).toBe(true);
      expect(isAllowedTechnicalLiteral(extended)).toBe(false);
    }
  });

  it('distinguishes kind comparisons from displayed labels', () => {
    expect(isKindComparison('if (scope.kind !== ')).toBe(true);
    expect(isKindComparison('scope.kind === ')).toBe(true);
    expect(isKindComparison('const label = ')).toBe(false);
    expect(isKindComparison('notify.info(')).toBe(false);
  });

  it('ignores property keys and indices while checking displayed copy', () => {
    expect(isPropertyName('type Model = { ', '?: string }')).toBe(true);
    expect(isPropertyName('ContentModelCatalog[', ']')).toBe(true);
    expect(isPropertyName('notify.info(', ')')).toBe(false);
    expect(isPropertyName('const label = ', ';')).toBe(false);
    expect(isPropertyName('const labels = [', ']')).toBe(false);
    expect(isPropertyName('condition ? ', ' : other')).toBe(false);
  });

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
          if (isKindComparison(line.slice(0, match.index)) || isPropertyName(line.slice(0, match.index), line.slice(match.index! + match[0].length))) {
            continue;
          }
          if (!literal || !/[A-Za-z]/.test(literal)) {
            continue;
          }
          if (isTechnicalCssLiteral(literal)) {
            continue;
          }
          if (isAllowedTechnicalLiteral(literal)) {
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
