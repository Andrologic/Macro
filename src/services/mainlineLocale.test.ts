import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const LOCALES = ['de', 'en', 'es', 'fr', 'ja', 'ko'];
const REQUIRED_PROJECT_KEYS = [
  'createDevelopDescription',
  'mainlineModeExplanation',
  'developModeLabel',
  'developModeExplanation',
];
const OLD_CREATE_DEVELOP_PATTERNS = [
  /simplify feature work/i,
  /simplifier le travail sur les features/i,
  /simplificar el trabajo de features/i,
  /Feature-Arbeit zu vereinfachen/i,
  /feature 作業を簡単にするため/i,
  /feature 작업을 더 쉽게/i,
];

const readLocale = (locale: string): Record<string, unknown> =>
  JSON.parse(
    readFileSync(join(process.cwd(), 'src', 'i18n', 'locales', `${locale}.json`), 'utf8')
  );

const getNestedRecord = (
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> => {
  const nested = value[key];
  expect(nested && typeof nested === 'object' && !Array.isArray(nested)).toBe(true);
  return nested as Record<string, unknown>;
};

describe('mainline locale copy', () => {
  it('keeps create-develop copy aligned with mainline workflow in every locale', () => {
    for (const locale of LOCALES) {
      const root = readLocale(locale);
      const project = getNestedRecord(root, 'project');
      const projects = getNestedRecord(root, 'projects');

      for (const key of REQUIRED_PROJECT_KEYS) {
        expect(typeof project[key], `${locale}.project.${key}`).toBe('string');
        expect(String(project[key]).length).toBeGreaterThan(0);
      }

      expect(project.createDevelopDescription).toContain('{{mainBranch}}');
      expect(project.mainlineModeExplanation).toContain('{{branchName}}');
      expect(String(project.mainlineModeExplanation)).toMatch(/hotfix/i);
      expect(String(project.mainlineModeExplanation)).not.toMatch(/feature-only/i);
      expect(project.developModeExplanation).toContain('{{branchName}}');
      expect(String(project.developModeExplanation)).toMatch(/Git[- ]Flow/i);
      expect(String(project.createDevelopDescription)).toMatch(/mainline/i);
      expect(project.createDevelopDescription).not.toMatch(
        new RegExp(OLD_CREATE_DEVELOP_PATTERNS.map((pattern) => pattern.source).join('|'), 'i')
      );
      expect(typeof projects.gitWorkflowMainlineBadge, `${locale}.projects.gitWorkflowMainlineBadge`)
        .toBe('string');
    }
  });

  it('uses Git workflow wording in settings locale copy', () => {
    for (const locale of LOCALES) {
      const root = readLocale(locale);
      const settings = getNestedRecord(root, 'settings');
      const architectGitFlow = getNestedRecord(settings, 'architectGitFlow');

      expect(typeof architectGitFlow.title, `${locale}.settings.architectGitFlow.title`).toBe('string');
      expect(typeof architectGitFlow.subtitle, `${locale}.settings.architectGitFlow.subtitle`).toBe('string');
      expect(architectGitFlow.title).not.toBe('Architect Git Flow');
      expect(architectGitFlow.subtitle).not.toMatch(/Git Flow profile/i);
    }
  });
});
