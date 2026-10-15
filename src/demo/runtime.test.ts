import { describe, expect, test } from 'bun:test';
import { createDemoRuntime, DemoUnsupportedCommand } from './runtime';

describe('isolated Macro demo runtime', () => {
  test('provides projects, real AgSDL source and task conversations', async () => {
    const demo = createDemoRuntime();
    const bootstrap = await demo.invoke('workspace_get_bootstrap') as { standaloneProjects: unknown[] };
    expect(bootstrap.standaloneProjects).toHaveLength(2);
    const file = await demo.invoke('fs_read_file', {
      path: 'branches/main/plans/demo-release/plan.json',
      workspaceScope: 'metadata', workspacePath: '/demo/luma',
    }) as { content: string };
    const plan = JSON.parse(file.content);
    expect(JSON.parse(plan.agsdl.source).agents).toBeDefined();
    expect(await demo.invoke('db_list_messages', { conversationId: 'demo-task-chat' })).toHaveLength(2);
  });

  test('keeps metadata separated between synthetic projects', async () => {
    const demo = createDemoRuntime();
    const path = 'branches/main/plans/demo-release/plan.json';
    await demo.invoke('fs_read_file', { path, workspaceScope: 'metadata', workspacePath: '/demo/luma' });
    await expect(demo.invoke('fs_read_file', { path, workspaceScope: 'metadata', workspacePath: '/demo/atlas' })).rejects.toThrow('introuvable');
  });

  test('writes only to memory and a new runtime resets the scenario', async () => {
    const demo = createDemoRuntime();
    const path = '/demo/luma/README.md';
    await demo.invoke('fs_write_file', { path, content: 'Changed in the demo' });
    expect(await demo.invoke('fs_read_file', { path })).toMatchObject({ content: 'Changed in the demo' });
    expect(await createDemoRuntime().invoke('fs_read_file', { path })).not.toMatchObject({ content: 'Changed in the demo' });
    await demo.invoke('fs_write_file', { path: '/outside/demo/example.txt', content: 'still virtual' });
    expect(demo.files.get('/outside/demo/example.txt')).toBe('still virtual');
  });

  test('persists messages using the same params envelope as the real IPC wrapper', async () => {
    const demo = createDemoRuntime();
    await demo.invoke('db_create_message', { params: { id: 'demo-sent', conversationId: 'demo-chat', role: 'user', content: 'Hello' } });
    expect(await demo.invoke('db_list_messages', { conversationId: 'demo-chat' })).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'demo-sent', role: 'user', content: 'Hello', conversation_id: 'demo-chat' }),
    ]));
  });

  test('stores settings and supports conditional updates without a database', async () => {
    const demo = createDemoRuntime();
    expect(await demo.invoke('db_compare_and_swap_app_setting', { key: 'draft', expectedValueJson: null, valueJson: 'first' })).toEqual({ applied: true });
    expect(await demo.invoke('db_compare_and_swap_app_setting', { key: 'draft', expectedValueJson: null, valueJson: 'lost' })).toEqual({ applied: false });
    expect(await demo.invoke('db_get_app_setting', { key: 'draft' })).toMatchObject({ value_json: 'first' });
    expect(await createDemoRuntime().invoke('db_get_app_setting', { key: 'draft' })).toBeNull();
  });

  test('simulates a response and Stop cancels it', async () => {
    const events: string[] = [];
    const demo = createDemoRuntime(name => events.push(name));
    await demo.invoke('ai_stream_chat', { request: { request_id: 'cancelled' } });
    await demo.invoke('ai_cancel_stream', { requestId: 'cancelled' });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(events).toEqual([]);
    await demo.invoke('ai_stream_chat', { request: { request_id: 'complete' } });
    await new Promise(resolve => setTimeout(resolve, 650));
    expect(events).toEqual(['ai:stream', 'ai:done']);
  });

  test('never forwards unknown commands or arbitrary native HTTP requests', async () => {
    const demo = createDemoRuntime();
    await expect(demo.invoke('shell_execute', { command: 'anything' })).rejects.toBeInstanceOf(DemoUnsupportedCommand);
    await expect(demo.invoke('plugin:http|fetch', { clientConfig: { url: 'https://example.invalid' } })).rejects.toBeInstanceOf(DemoUnsupportedCommand);
    expect(demo.unsupported.has('shell_execute')).toBe(true);
  });
});
