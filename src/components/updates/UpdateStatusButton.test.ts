import { describe, expect, test } from 'bun:test';
import { getUpdateButtonPresentation } from './UpdateStatusButton';

const translate = (_key: string, fallback: string, options?: Record<string, unknown>) =>
  fallback.replace('{{version}}', String(options?.version ?? ''))
    .replace('{{progress}}', String(options?.progress ?? ''));

describe('update status button presentation', () => {
  test('describes checking and download progress without emphasizing a restart', () => {
    expect(getUpdateButtonPresentation('checking', null, null, translate)).toMatchObject({
      icon: 'refresh-cw',
      spinning: true,
      emphasis: 'neutral',
    });
    expect(getUpdateButtonPresentation('downloading', '0.2.0', 42, translate)).toMatchObject({
      label: 'Downloading update: 42%',
      emphasis: 'neutral',
    });
  });

  test('makes a downloaded update and failures visible', () => {
    expect(getUpdateButtonPresentation('ready', '0.2.0', 100, translate)).toMatchObject({
      label: 'Update v0.2.0 will be installed the next time Macro opens',
      icon: 'check-circle',
      emphasis: 'ready',
    });
    expect(getUpdateButtonPresentation('error', '0.2.0', null, translate)).toMatchObject({
      icon: 'triangle-alert',
      emphasis: 'error',
    });
  });
});
