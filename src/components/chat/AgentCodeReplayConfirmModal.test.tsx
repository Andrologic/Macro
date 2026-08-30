import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { AgentCodeReplayPreview } from '../../types';
import {
  createTranslationMock,
  installReactI18nextMock,
} from '../../test-utils/reactI18nextMock';
import { AgentCodeReplayConfirmModal } from './AgentCodeReplayConfirmModal';

installReactI18nextMock(createTranslationMock());

const preview: AgentCodeReplayPreview = {
  conversationId: 'conv-1',
  messageId: 'user-1',
  targetCheckpointId: 'checkpoint-1',
  hasExternalChanges: true,
  affectedFiles: [
    {
      path: 'src/modified.ts',
      realPath: '/repo/src/modified.ts',
      action: 'modify',
      status: 'modified',
      target: { exists: true, content: 'old' },
      hasExternalChanges: true,
    },
    {
      path: 'src/created.ts',
      realPath: '/repo/src/created.ts',
      action: 'delete',
      status: 'created',
      target: { exists: false, content: null },
    },
    {
      path: 'src/deleted.ts',
      realPath: '/repo/src/deleted.ts',
      action: 'restore',
      status: 'deleted',
      target: { exists: true, content: 'restored' },
    },
  ],
};

describe('AgentCodeReplayConfirmModal', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it('lists affected files by replay status and shows the external-change warning', () => {
    act(() => {
      root.render(
        <AgentCodeReplayConfirmModal
          pendingReplayConfirmation={{
            kind: 'regenerate',
            messageId: 'user-1',
            content: 'retry',
            preview,
          }}
          isSubmitting={false}
          onCancel={mock()}
          onConfirm={mock()}
        />,
      );
    });

    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('modifié');
    expect(dialog?.textContent).toContain('src/modified.ts');
    expect(dialog?.textContent).toContain('créé');
    expect(dialog?.textContent).toContain('src/created.ts');
    expect(dialog?.textContent).toContain('supprimé');
    expect(dialog?.textContent).toContain('src/deleted.ts');
    expect(dialog?.textContent).toContain('Certains fichiers ont changé');
    expect(dialog?.textContent).toContain('changé');
    expect(dialog?.textContent).toContain(
      'Seuls les fichiers suivis par les outils d’édition de Macro sont restaurés',
    );
    expect(dialog?.textContent).toContain(
      'Les compactages de contexte après ce message seront recalculés',
    );
  });
});
