import { expect, it } from 'bun:test';
import { installLanguageNotifications, reportLanguageChange } from './languageNotifications';

it('delivers language notices before startup and after restart exactly once', () => {
  const messages: string[] = [];
  reportLanguageChange('Langue modifiée');
  const stop = installLanguageNotifications(message => messages.push(message));
  expect(messages).toEqual(['Langue modifiée']);
  stop();
  reportLanguageChange('Language changed');
  const restart = installLanguageNotifications(message => messages.push(message));
  expect(messages).toEqual(['Langue modifiée', 'Language changed']);
  restart();
});
