import { expect, test } from 'bun:test';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import { renderToStaticMarkup } from 'react-dom/server';
import fr from '../../../i18n/locales/fr.json';
import en from '../../../i18n/locales/en.json';
import { BackupRecoveryStatus, BackupStartupRecovery } from './BackupRecoveryStatus';

test('renders every native recovery status in French with separate technical diagnostics', async () => {
  const i18n = createInstance();
  await i18n.init({ lng: 'fr', resources: { fr: { translation: fr }, en: { translation: en } } });
  for (const [code, text] of [
    ['exported', 'Sauvegarde enregistrée.'],
    ['restored', 'Profil restauré.'],
    ['rolledBack', 'Le profil précédent a été récupéré.'],
    ['failed', 'L’opération de sauvegarde'],
    ['invalidRequest', 'La demande en attente était invalide'],
  ] as const) {
    const html = renderToStaticMarkup(<I18nextProvider i18n={i18n}><BackupRecoveryStatus status={{ code, path: '/synthetic/archive.json', message: 'Synthetic technical error', browser: null }} /></I18nextProvider>);
    expect(html).toContain(text);
    expect(html).toContain('/synthetic/archive.json');
    expect(html).toContain('<details><summary>Détails du diagnostic</summary><pre');
    expect(html).toContain('Synthetic technical error');
    expect(html.slice(0, html.indexOf('</p>'))).not.toContain('Synthetic technical error');
  }
  const legacy = renderToStaticMarkup(<I18nextProvider i18n={i18n}><BackupRecoveryStatus status={{ message: 'Backup saved: legacy', browser: null }} /></I18nextProvider>);
  expect(legacy).toContain('Le résultat d’une version précédente');
  expect(legacy).toContain('<pre class="whitespace-pre-wrap">Backup saved: legacy</pre>');
  const startup = renderToStaticMarkup(<I18nextProvider i18n={i18n}><BackupStartupRecovery error="Synthetic quota failure" /></I18nextProvider>);
  expect(startup).toContain('Récupération du profil nécessaire');
  expect(startup).toContain('redémarrez Macro');
  expect(startup).toContain('Synthetic quota failure');
});
