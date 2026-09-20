import { afterEach, describe, expect, it } from 'bun:test';
import { createWorkspaceSession, workspaceDefinitions } from '../domains/shell/workspace';
import { createModePanelLoader } from '../components/layout/panelLoader';
import { modePanelLoaders, resolveWorkspaceView, workspaceViews } from './workspaceViews';

const session = createWorkspaceSession(workspaceDefinitions.Chat, {
  agentType: 'plan', conversationId: 'chat-a', planId: null, taskId: null, projectId: null, groupId: null,
});
afterEach(() => { workspaceViews.removeOwner('test'); workspaceViews.setActive('view.chat', true); });

describe('workspace view composition', () => {
  it('routes a synthetic internal contribution and falls back after withdrawal without extending agent modes', () => {
    const loader = createModePanelLoader({ id: 'test.inspector', label: 'Inspector', mode: 'Chat', panel: 'center', importComponent: async () => () => null });
    const remove = workspaceViews.register({
      id: 'view.inspector', workspaceId: 'workspace.chat', owner: 'test', order: 5,
      label: 'Inspector', labelKey: 'test.inspector', icon: 'layers', panels: { center: loader },
      available: ({ executionTarget }) => executionTarget.kind === 'local',
    });
    expect(resolveWorkspaceView(session, 'view.inspector')?.panels.center).toBe(loader);
    expect(session.agentProfile).toEqual({ mode: 'Chat', agentType: 'plan' });
    remove();
    expect(resolveWorkspaceView(session, 'view.inspector')?.id).toBe('view.chat');
  });

  it('rejects cross-workspace selection and reflects default activation in compatibility consumers', () => {
    expect(resolveWorkspaceView(session, 'view.implement')?.id).toBe('view.chat');
    workspaceViews.setActive('view.chat', false);
    expect(resolveWorkspaceView(session)).toBeUndefined();
    expect(modePanelLoaders.Chat.center).toBeUndefined();
  });

  it('keeps the same shared ChatZone loader and delayed component cache', async () => {
    expect(modePanelLoaders.Chat.center).toBe(modePanelLoaders.Architect.center);
    expect(modePanelLoaders.Chat.center?.getCachedComponent()).toBeNull();
  });
});
