import { describe, expect, it } from 'bun:test';
import { createInstance } from 'i18next';
import en from '../i18n/locales/segments/implement-en.json';
import fr from '../i18n/locales/segments/implement-fr.json';
import { localizeTaskErrorMessage } from './taskErrorPresentation';

const translators = await Promise.all(['fr', 'en'].map(async (lng) => {
  const instance = createInstance();
  await instance.init({ showSupportNotice: false, lng, resources: {
    en: { translation: { implement: en } }, fr: { translation: { implement: fr } },
  }, interpolation: { escapeValue: false } });
  return { lng, translate: (key: string, options?: Readonly<Record<string, unknown>>) => String(instance.t(key, options)) };
}));

describe('task refusal presentation', () => {
  for (const { lng, translate } of translators) {
    it(`${lng} localizes the locked database refusal`, () => {
      for (const message of ['Database is locked',
        'Database error: error returned from database: (code: 5) database is locked']) {
        expect(localizeTaskErrorMessage(message, translate)).toBe(lng === 'fr'
          ? 'La base de données est verrouillée. Réessayez.' : 'The database is locked. Try again.');
      }
    });
    it(`${lng} preserves the active Direct task title verbatim`, () => {
      const title = 'Direct: <A> & B\nDeuxième ligne';
      expect(localizeTaskErrorMessage(`Direct-edit project already has an active task: ${title}`, translate))
        .toBe(`${lng === 'fr' ? 'Ce projet en édition directe possède déjà une tâche active :' : 'This direct-edit project already has an active task:'} ${title}`);
    });
    it(`${lng} preserves open todo labels and supports the refusal without labels`, () => {
      const todos = 'Relire <A>, vérifier B: C';
      const prefix = lng === 'fr' ? 'Impossible de terminer la tâche tant que des todos restent ouverts' : 'Cannot complete task while todos remain open';
      expect(localizeTaskErrorMessage(`Cannot complete task while todos remain open: ${todos}`, translate))
        .toBe(`${prefix}${lng === 'fr' ? ' :' : ':'} ${todos}`);
      expect(localizeTaskErrorMessage('Cannot complete task while todos remain open', translate))
        .toBe(`${prefix}${lng === 'fr' ? '.' : ''}`);
      // This is also the existing store's key and interpolation contract.
      expect(translate('implement.errors.taskTodosOpenForComplete', { todos }))
        .toBe(`${prefix}${lng === 'fr' ? ' :' : ':'} ${todos}`);
    });
    it(`${lng} keeps unknown errors and extra diagnostics unchanged`, () => {
      for (const message of ['SQLite error: Database is locked; path=/synthetic/db',
        'Database is locked: additional diagnostic',
        'Database error: error returned from database: (code: 5) database is locked; path=/synthetic/db',
        'Database error: error returned from database: (code: 6) database table is locked', 'Unexpected failure\nSQLITE_IOERR: 10',
        'Direct-edit project already has an active task:', 'Cannot complete task while todos remain open:']) {
        expect(localizeTaskErrorMessage(message, translate)).toBe(message);
      }
    });
  }
});
