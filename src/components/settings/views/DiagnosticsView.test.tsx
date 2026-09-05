import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

const generateMock = mock(async () => ({
  reportId: 'report-1',
  suggestedFileName: 'macro-diagnostic.json',
  content: '{\n  "privacy": { "excluded": ["secrets"] }\n}',
}));
const saveReportMock = mock(async (_reportId: string, _path: string) => undefined);
const saveDialogMock = mock(async () => '/tmp/macro-diagnostic.json' as string | null);
const notifySuccessMock = mock(() => undefined);
const notifyErrorMock = mock(() => undefined);

mock.module('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

mock.module('../../../services/tauriIpc', () => ({
  appDiagnosticGenerate: generateMock,
  appDiagnosticSave: saveReportMock,
}));

mock.module('../../../services/tauriDialog', () => ({ save: saveDialogMock }));
mock.module('../../ui/toastService', () => ({
  notify: { success: notifySuccessMock, error: notifyErrorMock },
}));
mock.module('../../ui/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

const { DiagnosticsView } = await import('./DiagnosticsView');

describe('DiagnosticsView', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    generateMock.mockClear();
    saveReportMock.mockClear();
    saveDialogMock.mockClear();
    notifySuccessMock.mockClear();
    notifyErrorMock.mockClear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const button = (label: string) => Array.from(container.querySelectorAll('button'))
    .find((candidate) => candidate.textContent?.trim() === label);

  it('requires a generated preview before saving the exact report', async () => {
    await act(async () => root.render(<DiagnosticsView />));

    expect(button('Save report')?.disabled).toBe(true);
    expect(container.querySelector('textarea')).toBeNull();

    await act(async () => {
      button('Generate preview')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    const preview = container.querySelector('textarea');
    expect(preview?.readOnly).toBe(true);
    expect(preview?.value).toContain('"excluded"');
    expect(button('Save report')?.disabled).toBe(false);

    await act(async () => {
      button('Save report')?.click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveDialogMock).toHaveBeenCalledTimes(1);
    expect(saveReportMock).toHaveBeenCalledWith('report-1', '/tmp/macro-diagnostic.json');
    expect(notifySuccessMock).toHaveBeenCalledTimes(1);
  });

  it('does not save when the user cancels the destination dialog', async () => {
    saveDialogMock.mockImplementationOnce(async () => null);
    await act(async () => root.render(<DiagnosticsView />));
    await act(async () => {
      button('Generate preview')?.click();
      await Promise.resolve();
      await Promise.resolve();
      button('Save report')?.click();
      await Promise.resolve();
    });
    expect(saveReportMock).not.toHaveBeenCalled();
  });
});
