import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import type React from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { CommitMessageEditorModal } from './CommitMessageEditorModal';
import { CommitMessageGenerationFailureModal } from './CommitMessageGenerationFailureModal';

mock.module('../ui/Icon', () => ({
  Icon: ({ name }: { name: string }) => <span data-icon={name} />,
}));

mock.module('../ui/Button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
    ...props
  }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button type={type} onClick={onClick} disabled={disabled} {...props}>
      {children}
    </button>
  ),
}));

mock.module('../ui/Textarea', () => ({
  Textarea: ({
    error: _error,
    ...props
  }: React.TextareaHTMLAttributes<HTMLTextAreaElement> & { error?: boolean }) => <textarea {...props} />,
}));

const t = (_key: string, fallback: string) => fallback;

describe('CommitMessage modals', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('renders generation failure actions and calls their callbacks', () => {
    const onRetryGeneration = mock(() => undefined);
    const onWriteManually = mock(() => undefined);
    const onOpenCommitModelSettings = mock(() => undefined);

    act(() => {
      root.render(
        <CommitMessageGenerationFailureModal
          t={t}
          error="missing API key"
          isGeneratingCommitMessages={false}
          onRetryGeneration={onRetryGeneration}
          onWriteManually={onWriteManually}
          onOpenCommitModelSettings={onOpenCommitModelSettings}
          onCancel={mock(() => undefined)}
        />
      );
    });

    expect(container.querySelector('[role="dialog"]')?.getAttribute('aria-modal')).toBe('true');
    expect(container.textContent).toContain('Couldn’t generate commit messages');
    expect(container.textContent).toContain('missing API key');

    const buttons = Array.from(container.querySelectorAll('button'));
    buttons.find((button) => button.textContent?.includes('Retry generation'))?.click();
    buttons.find((button) => button.textContent?.includes('Write manually'))?.click();
    buttons.find((button) => button.textContent?.includes('Metadata model settings'))?.click();

    expect(onRetryGeneration).toHaveBeenCalledTimes(1);
    expect(onWriteManually).toHaveBeenCalledTimes(1);
    expect(onOpenCommitModelSettings).toHaveBeenCalledTimes(1);
  });

  it('renders the manual fallback editor copy with repository fields', () => {

    act(() => {
      root.render(
        <CommitMessageEditorModal
          t={t}
          mode="manual_fallback"
          error={null}
          fieldsByRepositoryId={{
            repo: {
              type: 'chore',
              scope: null,
              breaking: false,
              subject: 'update task changes',
              body: null,
            },
          }}
          repositories={[{ id: 'repo', label: 'Repo' }]}
          validationsByRepositoryId={{}}
          isCommitting={false}
          isGeneratingCommitMessages={false}
          hasInvalidMessage={false}
          onCancel={mock(() => undefined)}
          onRetryGeneration={mock(() => undefined)}
          onCommit={mock(() => undefined)}
          onUpdateFields={mock((_repositoryId: string, _patch: unknown) => undefined)}
        />
      );
    });

    expect(container.textContent).toContain('Write commit messages');
    expect(container.textContent).toContain('Write a Conventional Commit message for each repository, then commit.');

    expect(container.querySelector('input[value="update task changes"]')).toBeDefined();
  });
});
