import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

process.env.MACRO_COPILOT_BRIDGE_TEST_IMPORT = '1';

const defineToolMock = mock((name: string, options: Record<string, unknown>) => ({
  name,
  options,
}));

mock.module('@github/copilot-sdk', () => ({
  CopilotClient: class {},
  defineTool: defineToolMock,
}));

let importCounter = 0;

const loadBridge = async () => {
  importCounter += 1;
  return import(`./index.ts?test=${importCounter}`);
};

afterEach(() => {
  defineToolMock.mockClear();
  delete process.env.MACRO_TOOL_HOST_URL;
  delete process.env.MACRO_TOOL_HOST_BEARER_TOKEN;
});

describe('copilot bridge tool registration', () => {
  it('normalizes the Copilot send timeout with room for tool and completion margins', async () => {
    const { __testables } = await loadBridge();

    expect(__testables.normalizeCopilotSendTimeoutMs(undefined)).toBe(1_860_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(null)).toBe(1_860_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(30_000)).toBe(1_860_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(60_000)).toBe(60_000);
    expect(__testables.normalizeCopilotSendTimeoutMs(1_800_500.8)).toBe(1_800_500);
  });

  it('keeps the frontend relay alive for the requested terminal runtime plus cleanup margin', async () => {
    const { __testables } = await loadBridge();

    expect(__testables.frontendToolTimeoutMs('read', {})).toBe(300_000);
    expect(__testables.frontendToolTimeoutMs('question', {})).toBe(1_830_000);
    expect(__testables.frontendToolTimeoutMs('need_user_input', {})).toBe(1_830_000);
    expect(__testables.frontendToolTimeoutMs('terminal_run', {})).toBe(300_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 900_000 }),
    ).toBe(930_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 1_800_000 }),
    ).toBe(1_830_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 9_000_000 }),
    ).toBe(1_830_000);
    expect(__testables.frontendToolTimeoutMs('question', {}, 60_000)).toBe(30_000);
    expect(
      __testables.frontendToolTimeoutMs('terminal_run', { timeout_ms: 900_000 }, 120_000),
    ).toBe(90_000);
  });

  it('serializes compacted system checkpoints outside the visible transcript', async () => {
    const { __testables } = await loadBridge();

    const serialized = __testables.serializeConversationPrompt([
      {
        role: 'system',
        content: 'You are Macro.',
      },
      {
        role: 'system',
        content: '[COMPACTED CONVERSATION STATE]\nOlder Copilot turns summarized.',
      },
      {
        role: 'user',
        content: 'Continue from the retained turn.',
      },
      {
        role: 'assistant',
        content: 'Retained assistant answer.',
      },
    ]);

    expect(serialized.system).toContain('You are Macro.');
    expect(serialized.system).toContain('[COMPACTED CONVERSATION STATE]');
    expect(serialized.prompt).toContain('[USER]\nContinue from the retained turn.');
    expect(serialized.prompt).toContain('[ASSISTANT]\nRetained assistant answer.');
    expect(serialized.prompt).not.toContain('[COMPACTED CONVERSATION STATE]');
    expect(serialized.prompt).not.toContain('Older Copilot turns summarized.');
  });

  it('passes Copilot built-in override metadata for web_fetch', async () => {
    const { __testables } = await loadBridge();

    const tools = __testables.buildMacroTools({
      request_id: 'req-1',
      model_id: 'gpt-5',
      messages: [],
      allowed_tool_ids: ['web_fetch', 'git_status'],
    }) as Array<{ name: string; options: { overridesBuiltInTool?: true } }>;

    const webFetchTool = tools.find((tool) => tool.name === 'web_fetch');
    const gitStatusTool = tools.find((tool) => tool.name === 'git_status');

    expect(webFetchTool?.options.overridesBuiltInTool).toBe(true);
    expect(gitStatusTool?.options.overridesBuiltInTool).toBeUndefined();
  });

  it('classifies supported Chat terminal tools without being confused by MCP ids', async () => {
    const { __testables } = await loadBridge();

    expect(
      __testables.inferMacroMode([
        'read_file',
        'terminal_create_session',
        'terminal_run',
        'mcp__github__list_issues',
      ]),
    ).toBe('Chat');
    expect(__testables.inferMacroMode(['read_file', 'write'])).toBe('Implement');
    expect(__testables.inferMacroMode(['read_file', 'plan_get'])).toBe('Architect');
  });

  it('relays every terminal tool to the frontend permission handler', async () => {
    const { __testables } = await loadBridge();
    const requestTool = mock(async (params: Record<string, unknown>) => ({
      result: `frontend:${String(params.toolName)}`,
      hiddenContext: null,
      visibleContent: null,
      interrupt: false,
    }));

    for (const toolId of [
      'terminal_create_session',
      'terminal_run',
      'terminal_read',
      'terminal_kill',
    ]) {
      expect(__testables.isFrontendRelayToolId(toolId)).toBe(true);
      const tools = __testables.buildMacroTools(
        {
          request_id: 'req-terminal',
          model_id: 'gpt-5',
          messages: [],
          allowed_tool_ids: [toolId],
        },
        { controlChannel: { requestTool } } as never,
      ) as Array<{
        name: string;
        options: {
          handler: (
            args: Record<string, unknown>,
            invocation: { sessionId: string; toolCallId: string; toolName: string },
          ) => Promise<string>;
        };
      }>;
      const terminalTool = tools.find((tool) => tool.name === toolId);

      await expect(
        terminalTool?.options.handler(
          { project_id: 'project-1', session_id: 'session-1', command: 'pwd' },
          {
            sessionId: 'session-1',
            toolCallId: `call-${toolId}`,
            toolName: toolId,
          },
        ),
      ).resolves.toBe(`frontend:${toolId}`);
    }

    expect(requestTool).toHaveBeenCalledTimes(4);
  });

  it('relays read_file arguments unchanged so the frontend can resolve artifacts and byte ranges', async () => {
    const { __testables } = await loadBridge();
    const requestTool = mock(async () => ({
      result: 'artifact contents',
      hiddenContext: null,
      visibleContent: null,
      interrupt: false,
    }));
    const tools = __testables.buildMacroTools(
      {
        request_id: 'req-read-file',
        model_id: 'gpt-5',
        messages: [],
        allowed_tool_ids: ['read_file'],
      },
      { controlChannel: { requestTool } } as never,
    ) as Array<{
      name: string;
      options: { handler: (args: Record<string, unknown>) => Promise<string> };
    }>;
    const args = {
      file: 'tool-output://artifact-1',
      raw: true,
      cursor: 'cursor-1',
      start_byte: 128,
      max_bytes: 4096,
    };

    await expect(
      tools.find((tool) => tool.name === 'read_file')?.options.handler(args),
    ).resolves.toBe('artifact contents');
    expect(requestTool).toHaveBeenCalledWith(expect.objectContaining({
      toolName: 'read_file',
      args,
    }));
  });

  it('relays workspace tools and mutating Git tools through the frontend unchanged', async () => {
    const { __testables } = await loadBridge();
    const requestTool = mock(async (params: Record<string, unknown>) => ({
      result: `frontend:${String(params.toolName)}`,
      hiddenContext: null,
      visibleContent: null,
      interrupt: false,
    }));
    const relayedToolIds = [
      'list',
      'read',
      'glob',
      'grep',
      'ast_grep',
      'write',
      'edit',
      'delete',
      'apply_patch',
      'git_add',
      'git_commit',
      'git_checkout',
      'git_merge',
      'git_reset',
      'git_stash',
      'git_branch_list',
      'git_get_tree',
    ];
    const tools = __testables.buildMacroTools(
      {
        request_id: 'req-relay',
        model_id: 'gpt-5',
        messages: [],
        default_workspace_path: '/tmp/default-project',
        virtual_root_enabled: true,
        project_mounts: [
          {
            project_id: 'web-project',
            mount_name: 'web',
            workspace_path: '/tmp/web-project',
            is_read_only: false,
          },
          {
            project_id: 'api-project',
            mount_name: 'api',
            workspace_path: '/tmp/api-project',
            is_read_only: false,
          },
        ],
        allowed_tool_ids: relayedToolIds,
      },
      { controlChannel: { requestTool } } as never,
    ) as Array<{
      name: string;
      options: {
        handler: (
          args: Record<string, unknown>,
          invocation: { sessionId: string; toolCallId: string; toolName: string },
        ) => Promise<string>;
      };
    }>;

    for (const toolId of relayedToolIds) {
      expect(__testables.isFrontendRelayToolId(toolId)).toBe(true);
      const args = {
        path: 'web/src/index.ts',
        repo_path: 'web',
        project_id: 'web-project',
        patch_text: '*** Begin Patch\n*** Delete File: web/old.txt\n*** End Patch',
      };
      await expect(
        tools.find((tool) => tool.name === toolId)?.options.handler(args, {
          sessionId: 'session-relay',
          toolCallId: `call-${toolId}`,
          toolName: toolId,
        }),
      ).resolves.toBe(`frontend:${toolId}`);
      expect(requestTool).toHaveBeenLastCalledWith(
        expect.objectContaining({ toolName: toolId, args }),
      );
    }

    expect(requestTool).toHaveBeenCalledTimes(relayedToolIds.length);
  });

  it('keeps read-only Git inspection on the confined Macro tool host', async () => {
    const fetchCalls: Array<Record<string, unknown>> = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async (_url: string, init?: RequestInit) => {
      fetchCalls.push(JSON.parse(String(init?.body ?? '{}')));
      return {
        ok: true,
        json: async () => ({ result: 'host ok' }),
      } as Response;
    }) as unknown as typeof fetch;
    process.env.MACRO_TOOL_HOST_URL = 'http://127.0.0.1:1456';
    process.env.MACRO_TOOL_HOST_BEARER_TOKEN = 'token-1';

    try {
      const { __testables } = await loadBridge();
      const tools = __testables.buildMacroTools({
        request_id: 'req-git-read',
        model_id: 'gpt-5',
        messages: [],
        default_workspace_path: '/tmp/macro-source',
        allowed_tool_ids: ['git_status'],
      }) as Array<{
        name: string;
        options: { handler: (args: Record<string, unknown>) => Promise<string> };
      }>;

      await expect(
        tools.find((tool) => tool.name === 'git_status')?.options.handler({ repo_path: '.' }),
      ).resolves.toBe('host ok');
      expect(fetchCalls).toEqual([
        expect.objectContaining({
          mode: 'Implement',
          tool_id: 'git_status',
          workspace_path: '/tmp/macro-source',
        }),
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('copilot bridge bounded workspace tools', () => {
  it('paginates list, read, glob, and grep with explicit metadata', async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'macro-copilot-tools-'));
    try {
      await writeFile(path.join(workspacePath, 'a.txt'), `${'x'.repeat(1_000)} needle\nsecond`);
      await writeFile(path.join(workspacePath, 'b.txt'), 'needle b\n');
      await writeFile(path.join(workspacePath, 'c.ts'), 'export const c = true;\n');
      await writeFile(path.join(workspacePath, 'binary.bin'), Buffer.from('needle\0binary'));
      const { __testables } = await loadBridge();
      const context = {
        defaultWorkspacePath: workspacePath,
        focusedProjectId: null,
        virtualRootEnabled: false,
        candidates: [],
      };

      const list = JSON.parse(await __testables.listWorkspace({
        context,
        pathValue: '.',
        limit: 1,
      }));
      expect(list.count).toBe(1);
      expect(list.truncated).toBe(true);
      expect(typeof list.next_cursor).toBe('string');

      const read = await __testables.readWorkspaceFile({
        context,
        pathValue: 'a.txt',
        maxLines: 1,
      });
      expect(read).toContain('TRUNCATED: true');
      expect(read).toContain('COLUMN_TRUNCATED_LINES: 0');
      const readCursor = read
        .split('\n')
        .find((line) => line.startsWith('NEXT_CURSOR: '))
        ?.slice('NEXT_CURSOR: '.length);
      expect(typeof readCursor).toBe('string');

      const glob = JSON.parse(await __testables.globWorkspace({
        context,
        pattern: '*.txt',
        limit: 1,
      }));
      expect(glob.paths).toEqual(['a.txt']);
      expect(glob.total_count).toBe(2);
      expect(glob.truncated).toBe(true);

      const grep = JSON.parse(await __testables.grepWorkspace({
        context,
        query: 'needle',
        limit: 1,
      }));
      expect(grep.count).toBe(1);
      expect(grep.truncated).toBe(true);
      expect(grep.results[0].text_truncated).toBe(true);
      expect(typeof grep.next_cursor).toBe('string');
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('rejects a read cursor after the file revision changes', async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'macro-copilot-read-'));
    try {
      const filePath = path.join(workspacePath, 'notes.txt');
      await writeFile(filePath, 'one\ntwo');
      const { __testables } = await loadBridge();
      const context = {
        defaultWorkspacePath: workspacePath,
        focusedProjectId: null,
        virtualRootEnabled: false,
        candidates: [],
      };
      const first = await __testables.readWorkspaceFile({
        context,
        pathValue: 'notes.txt',
        maxLines: 1,
      });
      const cursor = first
        .split('\n')
        .find((line) => line.startsWith('NEXT_CURSOR: '))
        ?.slice('NEXT_CURSOR: '.length);
      expect(typeof cursor).toBe('string');

      await writeFile(filePath, 'changed\ntwo');
      await expect(__testables.readWorkspaceFile({
        context,
        pathValue: 'notes.txt',
        maxLines: 1,
        cursor,
      })).rejects.toThrow('does not belong to this tool request');
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('rejects invalid UTF-8 instead of reporting it as binary', async () => {
    const workspacePath = await mkdtemp(path.join(tmpdir(), 'macro-copilot-encoding-'));
    try {
      await writeFile(path.join(workspacePath, 'invalid.txt'), Buffer.from([0xc3, 0x28]));
      const { __testables } = await loadBridge();
      const context = {
        defaultWorkspacePath: workspacePath,
        focusedProjectId: null,
        virtualRootEnabled: false,
        candidates: [],
      };

      await expect(__testables.readWorkspaceFile({
        context,
        pathValue: 'invalid.txt',
      })).rejects.toThrow('Invalid UTF-8 content');
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
    }
  });

  it('shares one bounded scan budget across virtual workspace mounts', async () => {
    const firstWorkspace = await mkdtemp(path.join(tmpdir(), 'macro-copilot-budget-a-'));
    const secondWorkspace = await mkdtemp(path.join(tmpdir(), 'macro-copilot-budget-b-'));
    try {
      await writeFile(path.join(firstWorkspace, 'a.txt'), 'a');
      await writeFile(path.join(firstWorkspace, 'b.txt'), 'b');
      await writeFile(path.join(secondWorkspace, 'c.txt'), 'c');
      await writeFile(path.join(secondWorkspace, 'd.txt'), 'd');
      const { __testables } = await loadBridge();
      const context = {
        defaultWorkspacePath: firstWorkspace,
        focusedProjectId: null,
        virtualRootEnabled: true,
        candidates: [
          {
            id: 'a',
            mountName: 'a',
            displayName: 'A',
            workspacePath: firstWorkspace,
          },
          {
            id: 'b',
            mountName: 'b',
            displayName: 'B',
            workspacePath: secondWorkspace,
          },
        ],
      };

      expect(__testables.WORKSPACE_SCAN_CANDIDATE_LIMIT).toBe(20_000);
      await expect(__testables.globWorkspace({
        context,
        pattern: '**/*.txt',
        scanBudget: __testables.createWorkspaceScanBudget(3),
      })).rejects.toThrow('cumulative safety limit of 3 entries across all project mounts');
      await expect(__testables.grepWorkspace({
        context,
        query: 'missing',
        scanBudget: __testables.createWorkspaceScanBudget(3),
      })).rejects.toThrow('cumulative safety limit of 3 entries across all project mounts');
    } finally {
      await rm(firstWorkspace, { recursive: true, force: true });
      await rm(secondWorkspace, { recursive: true, force: true });
    }
  });

  it('confines symbolic links to canonical workspace paths without following directory cycles', async () => {
    if (process.platform === 'win32') return;

    const workspacePath = await mkdtemp(path.join(tmpdir(), 'macro-copilot-links-'));
    const outsidePath = await mkdtemp(path.join(tmpdir(), 'macro-copilot-outside-'));
    try {
      await mkdir(path.join(workspacePath, 'internal'));
      await writeFile(path.join(workspacePath, 'internal', 'inside.txt'), 'inside needle');
      await writeFile(path.join(outsidePath, 'secret.txt'), 'outside needle');
      await symlink(path.join(workspacePath, 'internal', 'inside.txt'), path.join(workspacePath, 'inside-link.txt'));
      await symlink('internal', path.join(workspacePath, 'internal-directory-link'));
      await symlink(path.join(outsidePath, 'secret.txt'), path.join(workspacePath, 'outside-link.txt'));
      await symlink('.', path.join(workspacePath, 'internal', 'cycle'));
      await symlink(outsidePath, path.join(workspacePath, 'outside-directory'));

      const { __testables } = await loadBridge();
      const context = {
        defaultWorkspacePath: workspacePath,
        focusedProjectId: null,
        virtualRootEnabled: false,
        candidates: [],
      };

      const internalRead = await __testables.readWorkspaceFile({
        context,
        pathValue: 'inside-link.txt',
      });
      expect(internalRead).toContain('inside needle');
      await expect(__testables.readWorkspaceFile({
        context,
        pathValue: 'outside-link.txt',
      })).rejects.toThrow('resolves outside the workspace');
      await expect(__testables.listWorkspace({
        context,
        pathValue: 'outside-directory',
        recursive: true,
      })).rejects.toThrow('resolves outside the workspace');
      const linkedDirectory = JSON.parse(await __testables.listWorkspace({
        context,
        pathValue: 'internal-directory-link',
        recursive: true,
      }));
      expect(linkedDirectory.entries).toContainEqual({
        relative_path: 'internal-directory-link/inside.txt',
        kind: 'file',
      });

      const grep = JSON.parse(await __testables.grepWorkspace({
        context,
        query: 'needle',
        limit: 10,
      }));
      expect(grep.results.map((result: { path: string }) => result.path)).toEqual([
        'inside-link.txt',
        'internal/inside.txt',
      ]);
      expect(JSON.stringify(grep)).not.toContain('outside-link.txt');

      const glob = JSON.parse(await __testables.globWorkspace({
        context,
        pattern: '**',
        limit: 20,
      }));
      expect(glob.paths).toContain('inside-link.txt');
      expect(glob.paths).toContain('internal/inside.txt');
      expect(glob.paths).not.toContain('internal-directory-link/inside.txt');
      expect(glob.paths).not.toContain('outside-link.txt');
      expect(glob.paths).not.toContain('outside-directory/secret.txt');
    } finally {
      await rm(workspacePath, { recursive: true, force: true });
      await rm(outsidePath, { recursive: true, force: true });
    }
  });
});

describe('copilot bridge reasoning events', () => {
  it('streams Copilot reasoning deltas inside a think block before response text', async () => {
    const { __testables } = await loadBridge();
    const state = __testables.createCopilotSessionEventState();
    const emitted: Array<Record<string, unknown>> = [];
    const emit = (payload: Record<string, unknown>) => {
      emitted.push(payload);
    };

    const common = {
      state,
      toolTraces: new Map(),
      hiddenContextBlocks: [],
      emit,
    };

    __testables.handleCopilotSessionEvent({
      ...common,
      event: {
        type: 'assistant.reasoning_delta',
        data: { reasoningId: 'reasoning-1', deltaContent: 'Inspecting files.' },
      },
    });
    __testables.handleCopilotSessionEvent({
      ...common,
      event: {
        type: 'assistant.reasoning_delta',
        data: { reasoningId: 'reasoning-1', deltaContent: ' Choosing fix.' },
      },
    });
    __testables.handleCopilotSessionEvent({
      ...common,
      event: {
        type: 'assistant.message_delta',
        data: { messageId: 'message-1', deltaContent: 'Done.' },
      },
    });

    expect(emitted.map((payload) => payload.delta)).toEqual([
      '<think>',
      'Inspecting files.',
      ' Choosing fix.',
      '</think>\n',
      'Done.',
    ]);
    expect(__testables.getCopilotReasoningSummary(state)).toBe(
      'Inspecting files. Choosing fix.'
    );
  });

  it('uses assistant message reasoningText as the readable reasoning fallback', async () => {
    const { __testables } = await loadBridge();
    const state = __testables.createCopilotSessionEventState();
    const emitted: Array<Record<string, unknown>> = [];

    __testables.handleCopilotSessionEvent({
      event: {
        type: 'assistant.message',
        data: {
          messageId: 'message-1',
          content: 'Final answer.',
          reasoningText: 'Readable Copilot thinking.',
        },
      },
      state,
      toolTraces: new Map(),
      hiddenContextBlocks: [],
      emit: (payload: Record<string, unknown>) => {
        emitted.push(payload);
      },
    });

    expect(emitted).toEqual([]);
    expect(state.finalContent).toBe('Final answer.');
    expect(__testables.getCopilotReasoningSummary(state)).toBe(
      'Readable Copilot thinking.'
    );
  });
});
