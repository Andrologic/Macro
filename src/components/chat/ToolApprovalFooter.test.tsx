import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

let latestTextareaOnChange:
  | ((event: { target: { value: string } }) => void)
  | null = null;
let importCounter = 0;

const loadToolApprovalFooter = async () => {
  mock.restore();
  latestTextareaOnChange = null;

  mock.module('react-i18next', () => ({
    useTranslation: () => ({
      t: (
        _key: string,
        fallbackOrOptions?: string | { defaultValue?: string; [key: string]: unknown },
        maybeOptions?: { defaultValue?: string; [key: string]: unknown }
      ) => {
        const template =
          typeof fallbackOrOptions === 'string'
            ? fallbackOrOptions
            : maybeOptions?.defaultValue ?? fallbackOrOptions?.defaultValue ?? _key;
        const options = typeof fallbackOrOptions === 'string' ? maybeOptions : fallbackOrOptions;
        return Object.entries(options ?? {}).reduce(
          (value, [key, replacement]) =>
            value.replaceAll(`{{${key}}}`, String(replacement)),
          template,
        );
      },
    }),
  }));

  mock.module('../ui/Icon', () => ({
    Icon: ({ name }: { name: string }) => <span data-icon={name} />,
  }));

  mock.module('../ui/Button', () => ({
    Button: ({
      children,
      ...props
    }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...props}>{children}</button>,
  }));

  mock.module('../ui/Textarea', () => ({
    Textarea: ({
      onChange,
      'data-testid': testId,
      ...props
    }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { 'data-testid'?: string }) => {
      latestTextareaOnChange = onChange as never;
      return <textarea data-testid={testId} onChange={onChange} {...props} />;
    },
  }));

  mock.module('../../utils/cn', () => ({
    cn: (...values: Array<string | false | null | undefined>) =>
      values.filter(Boolean).join(' '),
  }));

  const skillStoreState = {
    getSkillById: (skillId: string) =>
      skillId === 'global:test-skill'
        ? { id: skillId, name: 'test-skill' }
        : null,
  };
  const useSkillsStore = ((selector?: (state: typeof skillStoreState) => unknown) =>
    selector ? selector(skillStoreState) : skillStoreState) as unknown as {
    <T>(selector: (state: typeof skillStoreState) => T): T;
  };
  mock.module('../../stores/useSkillsStore', () => ({ useSkillsStore }));

  importCounter += 1;
  return import(`./ToolApprovalFooter.tsx?test=${importCounter}`);
};

describe('ToolApprovalFooter', () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    container = null;
    root = null;
    mock.restore();
  });

  it('passes the optional denial reason to the caller', async () => {
    const onDeny = mock(() => undefined);
    const { ToolApprovalFooter } = await loadToolApprovalFooter();

    await act(async () => {
      root?.render(
        <ToolApprovalFooter
          pendingApproval={{
            conversationId: 'conv-1',
            assistantMessageId: 'msg-1',
            toolCallId: 'tool-1',
            toolId: 'terminal_run',
            actionGroup: 'escape',
            riskLevel: 'balanced',
            isDestructive: true,
            summary: 'Run a terminal command',
            detail: 'npm test',
            rememberKey: 'terminal:npm test',
            canApproveForConversation: false,
          }}
          onAllowOnce={() => undefined}
          onAllowForConversation={() => undefined}
          onDeny={onDeny}
        />
      );
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Requested command');
    expect(container?.textContent).toContain('System');
    expect(container?.textContent).toContain('Allow once');
    expect(container?.textContent).not.toContain('Allow for this conversation');
    expect(container?.textContent).not.toContain('terminal_run');
    expect(container?.textContent).not.toContain('Balanced');
    expect(container?.querySelector('[data-icon="shield"]')).not.toBeNull();

    const denyButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Refuse')
    );
    await act(async () => {
      denyButton?.click();
    });

    await act(async () => {
      latestTextareaOnChange?.({
        target: { value: 'Stay inside the repo only.' },
      });
    });

    const confirmButton = Array.from(container?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Confirm denial')
    );
    await act(async () => {
      confirmButton?.click();
    });

    expect(onDeny).toHaveBeenCalledWith('Stay inside the repo only.');
  });

  it('maps approval categories and risk icons for different request types', async () => {
    const { ToolApprovalFooter } = await loadToolApprovalFooter();

    await act(async () => {
      root?.render(
        <div>
          <ToolApprovalFooter
            pendingApproval={{
              conversationId: 'conv-1',
              assistantMessageId: 'msg-1',
              toolCallId: 'tool-1',
              toolId: 'web_fetch',
              actionGroup: 'escape',
              riskLevel: 'strict',
              isDestructive: false,
              summary: 'Fetch a web page',
              detail: 'https://example.com',
              rememberKey: 'domain:example.com',
            }}
            onAllowOnce={() => undefined}
            onAllowForConversation={() => undefined}
            onDeny={() => undefined}
          />
          <ToolApprovalFooter
            pendingApproval={{
              conversationId: 'conv-2',
              assistantMessageId: 'msg-2',
              toolCallId: 'tool-2',
              toolId: 'git_commit',
              actionGroup: 'change',
              riskLevel: 'yolo',
              isDestructive: false,
              summary: 'Create a git commit',
              detail: '.',
              rememberKey: 'path:.',
            }}
            onAllowOnce={() => undefined}
            onAllowForConversation={() => undefined}
            onDeny={() => undefined}
          />
        </div>
      );
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Web');
    expect(container?.textContent).toContain('Modify');
    expect(container?.querySelector('[data-icon="lock"]')).not.toBeNull();
    expect(container?.querySelector('[data-icon="zap"]')).not.toBeNull();
  });

  it('shows skill script approval details', async () => {
    const { ToolApprovalFooter } = await loadToolApprovalFooter();

    await act(async () => {
      root?.render(
        <ToolApprovalFooter
          pendingApproval={{
            conversationId: 'conv-1',
            assistantMessageId: 'msg-1',
            toolCallId: 'tool-1',
            toolId: 'skill_run_script',
            actionGroup: 'escape',
            riskLevel: 'balanced',
            isDestructive: true,
            summary: 'Run a skill script',
            detail: 'scripts/check.sh',
            args: {
              skill_id: 'global:test-skill',
              script_path: 'scripts/check.sh',
              args: ['--quick'],
              timeout_ms: 120000,
              allow_workspace: true,
            },
            rememberKey: 'tool:skill_run_script',
          }}
          onAllowOnce={() => undefined}
          onAllowForConversation={() => undefined}
          onDeny={() => undefined}
        />
      );
      await Promise.resolve();
    });

    expect(container?.textContent).toContain('Skill');
    expect(container?.textContent).toContain('test-skill');
    expect(container?.textContent).toContain('scripts/check.sh');
    expect(container?.textContent).toContain('--quick');
    expect(container?.textContent).toContain('120s timeout');
  });
});
