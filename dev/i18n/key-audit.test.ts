import { describe, expect, it } from 'bun:test';
import { auditTranslationKeys, isUntranslatedEnglish } from './key-audit.mjs';

const keys = new Map([
  ['common.save', 'Save'],
  ['prompts.editors.promptChat.label', 'Chat'],
  ['tools.mcp.status.online', 'Online'],
  ['agsdl.execution.state.failed', 'Failed'],
]);
const audit = (source: string) => auditTranslationKeys(source, 'example.tsx', keys);

describe('translation audit regressions', () => {
  it('rejects copied English unless the exact locale, key and source value are allowed', () => {
    const allowlist = { de: { 'common.save': 'Save' } };
    expect(isUntranslatedEnglish('de', 'common.save', 'Save', 'Save', {})).toBe(true);
    expect(isUntranslatedEnglish('de', 'common.save', 'Save', 'Save', allowlist)).toBe(false);
    expect(isUntranslatedEnglish('es', 'common.save', 'Save', 'Save', allowlist)).toBe(true);
    expect(isUntranslatedEnglish('de', 'common.save', 'Save now', 'Save now', allowlist)).toBe(true);
    expect(isUntranslatedEnglish('en', 'common.save', 'Save', 'Save', {})).toBe(false);
  });

  it('checks dynamic prefixes as subtrees, including templates with a suffix', () => {
    expect(audit('t(`prompts.editors.${key}.label`); t(`tools.mcp.status.${status}`)')).toEqual([]);
    expect(audit('t(`missing.${key}`)')).toEqual(['references missing i18n subtree: missing']);
    expect(audit('t(`common.save.${key}`)')).toEqual(['references missing i18n subtree: common.save']);
    expect(audit('// t(`missing.${key}`)\nconst text = "t(`missing.${key}`)"')).toEqual([]);
  });

  it('detects default namespace AgSDL calls without confusing scoped bindings', () => {
    expect(audit('const { t } = useTranslation(); t(`agsdl.execution.state.${state}`)')).toContain(
      'uses agsdl.execution.state with the default namespace; use the agsdl namespace',
    );
    expect(audit('const { t } = useTranslation(); t("agsdl.execution.state.failed", { ns: "agsdl" })')).toEqual([]);
    expect(audit('const { t: translate } = useAgsdlTranslation(); translate("agsdl.execution.state.failed")')).toEqual([]);
    expect(audit('function a() { const { t } = useAgsdlTranslation(); t("agsdl.execution.state.failed"); } function b() { const { t } = useTranslation(); t("agsdl.execution.state.failed"); }')).toHaveLength(1);
    expect(audit('const t = i18n.getFixedT(null, "agsdl"); t("agsdl.execution.state.failed")')).toEqual([]);
  });
});
