import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WorktreeDiagnosticTarget } from '../../services/worktreeDiagnostics';

const inspection = { status: 'orphan_path', worktreePath: '/tmp/qa/worktree', branchName: null, isDirty: null };
const inspectMock = mock(async () => inspection);
const repairMock = mock(async () => inspection);
const notifyError = mock((_title: string, _options: { description: string }) => undefined);
mock.module('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
mock.module('../../services/worktreeDiagnostics', () => ({ inspectWorktree: inspectMock, repairWorktree: repairMock }));
mock.module('../ui/toastService', () => ({ notify: { success: mock(() => undefined), error: notifyError } }));
const { WorktreeDiagnosticsDialog } = await import('./WorktreeDiagnosticsDialog');
const entry = {
  target: { projectId: 'qa', worktreeKey: 'qa', branchName: 'feature/qa' },
  project: { name: 'QA', path: '/tmp/qa' },
} as WorktreeDiagnosticTarget;
let container: HTMLDivElement;
let root: Root;
beforeEach(() => {
  inspectMock.mockReset(); inspectMock.mockImplementation(async () => inspection);
  repairMock.mockReset(); repairMock.mockImplementation(async () => inspection);
  notifyError.mockClear();
  container = document.createElement('div'); document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
const render = async () => {
  await act(async () => { root.render(<WorktreeDiagnosticsDialog entries={[entry]} repairDisabled={false} onClose={() => undefined} />); });
};

it('shows the structured native inspection error message', async () => {
  inspectMock.mockImplementationOnce(async () => { throw { code: 'Git', message: 'Inspection refused: repository unavailable.' }; });
  await render();
  expect(document.querySelector('[role="alert"]')?.textContent).toBe('Inspection refused: repository unavailable.');
  expect(document.body.textContent).not.toContain('[object Object]');
});

it('preserves the native repair refusal in the panel and notification', async () => {
  const message = 'Worktree repair refused to preserve data. Move this path to a safe backup location.';
  repairMock.mockImplementationOnce(async () => { throw { code: 'Git', message }; });
  await render();
  const repairButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent === 'implement.worktreeDiagnostic.repair');
  expect(repairButton?.disabled).toBe(false);
  await act(async () => { repairButton!.click(); });
  expect(document.querySelector('[role="alert"]')?.textContent).toBe(message);
  expect(notifyError).toHaveBeenCalledWith('implement.worktreeDiagnostic.refused', { description: message });
  expect(document.body.textContent).not.toContain('[object Object]');
});
