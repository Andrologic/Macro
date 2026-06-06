import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ArtifactDiffModal as ArtifactDiffModalComponent } from './ArtifactDiffModal';
import type { ArchitectPlanRecord } from '../../services/architectPlanService';
import type {
  PlanArtifactExpectedOverviewItem,
  VisiblePlanTaskArtifactDiff,
  VisiblePlanTaskArtifactReviewEntry,
} from '../../services/architectPlanArtifactService';
import type { CatalogedImplementTask } from '../../services/implementTaskCatalog';

let ArtifactDiffModal!: typeof ArtifactDiffModalComponent;
let importCounter = 0;
let readDiffMock: ReturnType<typeof mock>;
let readPlanDiffMock: ReturnType<typeof mock>;
let putArtifactMock: ReturnType<typeof mock>;

const translationMock = {
  t: (
    _key: string,
    fallbackOrOptions?: string | { defaultValue?: string; count?: number },
    maybeOptions?: { defaultValue?: string; count?: number },
  ) => {
    const options = typeof fallbackOrOptions === 'object' ? fallbackOrOptions : maybeOptions;
    if (typeof fallbackOrOptions === 'string') {
      return fallbackOrOptions;
    }
    return options?.defaultValue ?? _key;
  },
};

const loadArtifactDiffModal = async () => {
  importCounter += 1;

  mock.module('react-i18next', () => ({
    useTranslation: () => translationMock,
  }));

  const reactModule = await import('react');
  mock.module('../chat/MarkdownRenderer', () => ({
    MarkdownRenderer: ({ content }: { content: string }) =>
      reactModule.createElement('div', { 'data-testid': 'artifact-markdown-renderer' }, content),
  }));

  mock.module('../ui/DiffMergeView', () => ({
    DiffMergeView: ({
      modified,
      layout,
      editable,
      onChange,
    }: {
      modified: string;
      layout?: string;
      editable?: boolean;
      onChange?: (value: string) => void;
    }) =>
      reactModule.createElement('textarea', {
        'data-testid': 'artifact-code-editor',
        'data-layout': layout,
        'data-editable': String(Boolean(editable)),
        value: modified,
        onChange: (event: { currentTarget: HTMLTextAreaElement }) => onChange?.(event.currentTarget.value),
      }),
  }));

  mock.module('../../services/architectPlanArtifactService', () => ({
    readPlanArtifactDiff: (...args: unknown[]) => readPlanDiffMock(...args),
    readVisibleTaskArtifactDiff: (...args: unknown[]) => readDiffMock(...args),
    putTaskArtifact: (...args: unknown[]) => putArtifactMock(...args),
  }));

  ({ ArtifactDiffModal } = await import(`./ArtifactDiffModal.tsx?artifact-diff-modal-test=${importCounter}`));
};

const plan = {
  id: 'plan-1',
  title: 'Plan',
  nodes: [
    { id: 'task-1', title: 'Current task' },
    { id: 'audit', title: 'Audit task' },
  ],
  projectIds: ['project-1'],
} as unknown as ArchitectPlanRecord;

const task = {
  id: 'task-1',
  title: 'Current task',
  task_source: 'architect',
  plan_id: 'plan-1',
  execution_targets: [{ repoPath: '/tmp/repo' }],
} as unknown as CatalogedImplementTask;

const buildEntry = (
  artifact: VisiblePlanTaskArtifactDiff['artifact'],
): VisiblePlanTaskArtifactReviewEntry => ({
  artifact,
  review: null,
  hasValidatedReview: false,
  hasPendingReview: true,
});

const ownMarkdownArtifact: VisiblePlanTaskArtifactDiff['artifact'] = {
  id: 'api-contract',
  planId: 'plan-1',
  taskId: 'task-1',
  kind: 'technical-kind',
  title: 'API contract',
  summary: 'API summary',
  contentType: 'markdown',
  path: 'branches/main/plans/plan-1/artifacts/tasks/task-1/api-contract.md',
  contentHash: 'hash-1',
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  createdBy: 'agent',
  contractId: 'api-contract',
  visibility: 'own',
};

const inheritedMarkdownArtifact: VisiblePlanTaskArtifactDiff['artifact'] = {
  ...ownMarkdownArtifact,
  id: 'audit-findings',
  taskId: 'audit',
  title: 'Audit findings',
  summary: 'Audit summary',
  path: 'branches/main/plans/plan-1/artifacts/tasks/audit/audit-findings.md',
  contractId: undefined,
  visibility: 'inherited',
};

const jsonArtifact: VisiblePlanTaskArtifactDiff['artifact'] = {
  ...ownMarkdownArtifact,
  id: 'api-map',
  title: 'API map',
  contentType: 'json',
  path: 'branches/main/plans/plan-1/artifacts/tasks/task-1/api-map.json',
};

const renderModal = async (params: {
  artifactId: string | null;
  entries: VisiblePlanTaskArtifactReviewEntry[];
  expectedItems?: PlanArtifactExpectedOverviewItem[];
  context?: 'review' | 'readOnly';
  task?: CatalogedImplementTask | null;
  onArtifactSaved?: ReturnType<typeof mock>;
}) => {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  const onArtifactSaved = params.onArtifactSaved ?? mock(async () => undefined);

  await act(async () => {
    root.render(
      <ArtifactDiffModal
        branchName="main"
        plan={plan}
        task={params.task === undefined ? task : params.task}
        entries={params.entries}
        expectedItems={params.expectedItems}
        artifactId={params.artifactId}
        context={params.context}
        onSelectArtifact={mock(() => undefined)}
        onValidate={mock(async () => undefined)}
        onUnvalidate={mock(async () => undefined)}
        onArtifactSaved={onArtifactSaved}
        onClose={mock(() => undefined)}
      />,
    );
    await flushRender();
  });

  return { container, root, onArtifactSaved };
};

const flushRender = async () => {
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => resolve());
    });
  });
  await Promise.resolve();
};

const findButton = (label: string): HTMLButtonElement | undefined =>
  Array.from(document.body.querySelectorAll('button')).find((button) =>
    button.textContent?.includes(label),
  ) as HTMLButtonElement | undefined;

const setTextareaValue = (textarea: HTMLTextAreaElement, value: string) => {
  const valueSetter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype,
    'value',
  )?.set;
  valueSetter?.call(textarea, value);
  textarea.dispatchEvent(new window.Event('input', { bubbles: true }));
};

describe('ArtifactDiffModal', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(async () => {
    readDiffMock = mock(async () => ({
      artifact: ownMarkdownArtifact,
      content: '# API contract\n\nInitial body',
      previousArtifact: null,
      previousContent: '',
      status: 'added',
    }));
    readPlanDiffMock = mock(async () => ({
      artifact: ownMarkdownArtifact,
      content: '# API contract\n\nInitial body',
      previousArtifact: null,
      previousContent: '',
      status: 'added',
    }));
    putArtifactMock = mock(async () => ownMarkdownArtifact);
    await loadArtifactDiffModal();
  });

  afterEach(async () => {
    await act(async () => {
      root?.unmount();
      await Promise.resolve();
    });
    container?.remove();
    root = null;
    container = null;
    document.body.innerHTML = '';
    mock.restore();
  });

  it('opens markdown artifacts in rendered preview and can switch to code', async () => {
    ({ container, root } = await renderModal({
      artifactId: ownMarkdownArtifact.id,
      entries: [buildEntry(ownMarkdownArtifact)],
    }));

    const selectedArtifactButton = document.body.querySelector<HTMLButtonElement>('button[title="API contract"]');
    expect(selectedArtifactButton?.disabled).toBe(false);
    expect(selectedArtifactButton?.getAttribute('aria-current')).toBe('true');
    expect(selectedArtifactButton?.textContent).toContain('API summary');
    expect(selectedArtifactButton?.textContent).not.toContain('technical-kind');
    expect(document.body.querySelector('[data-artifact-markdown-preview="true"]')).not.toBeNull();
    expect(document.body.textContent).toContain('# API contract');
    expect(document.body.querySelector('[data-testid="artifact-code-editor"]')).toBeNull();

    await act(async () => {
      findButton('Code')?.click();
      await flushRender();
    });

    const editor = document.body.querySelector('[data-testid="artifact-code-editor"]') as HTMLTextAreaElement | null;
    expect(editor).not.toBeNull();
    expect(editor?.getAttribute('data-editable')).toBe('false');
    expect(editor?.value).toContain('Initial body');
  });

  it('updates markdown preview from code edits and saves current-task artifacts in place', async () => {
    const onArtifactSaved = mock(async () => undefined);
    ({ container, root } = await renderModal({
      artifactId: ownMarkdownArtifact.id,
      entries: [buildEntry(ownMarkdownArtifact)],
      onArtifactSaved,
    }));

    await act(async () => {
      findButton('Edit')?.click();
      await flushRender();
    });
    await act(async () => {
      findButton('Code')?.click();
      await flushRender();
    });
    const editor = document.body.querySelector('[data-testid="artifact-code-editor"]') as HTMLTextAreaElement;

    await act(async () => {
      setTextareaValue(editor, '# API contract\n\nUpdated body');
      await flushRender();
    });
    await act(async () => {
      findButton('Preview')?.click();
      await flushRender();
    });

    expect(document.body.textContent).toContain('Updated body');

    await act(async () => {
      findButton('Save')?.click();
      await flushRender();
    });

    expect(putArtifactMock).toHaveBeenCalledTimes(1);
    expect(putArtifactMock.mock.calls[0]?.[0]).toMatchObject({
      createdBy: 'user',
      args: {
        artifact_id: 'api-contract',
        content: '# API contract\n\nUpdated body',
        content_type: 'markdown',
        contract_id: 'api-contract',
      },
    });
    expect(putArtifactMock.mock.calls[0]?.[0]?.args).not.toHaveProperty('supersedes_artifact_id');
    expect(onArtifactSaved).toHaveBeenCalledWith('api-contract');
  });

  it('saves inherited artifact edits as a current-task version with supersedes', async () => {
    readDiffMock = mock(async () => ({
      artifact: inheritedMarkdownArtifact,
      content: '# Audit\n\nParent finding',
      previousArtifact: null,
      previousContent: '',
      status: 'added',
    }));
    putArtifactMock = mock(async () => ({
      ...inheritedMarkdownArtifact,
      id: 'audit-findings-task-1',
      taskId: 'task-1',
      supersedes: 'audit-findings',
      visibility: 'own',
    }));
    await loadArtifactDiffModal();
    const onArtifactSaved = mock(async () => undefined);
    ({ container, root } = await renderModal({
      artifactId: inheritedMarkdownArtifact.id,
      entries: [buildEntry(inheritedMarkdownArtifact)],
      onArtifactSaved,
    }));

    await act(async () => {
      findButton('Edit')?.click();
      await flushRender();
    });
    await act(async () => {
      findButton('Code')?.click();
      await flushRender();
    });
    const editor = document.body.querySelector('[data-testid="artifact-code-editor"]') as HTMLTextAreaElement;
    await act(async () => {
      setTextareaValue(editor, '# Audit\n\nChild revision');
      await flushRender();
    });
    await act(async () => {
      findButton('Save')?.click();
      await flushRender();
    });

    expect(putArtifactMock).toHaveBeenCalledTimes(1);
    expect(putArtifactMock.mock.calls[0]?.[0]).toMatchObject({
      createdBy: 'user',
      args: {
        content: '# Audit\n\nChild revision',
        supersedes_artifact_id: 'audit-findings',
      },
    });
    expect(putArtifactMock.mock.calls[0]?.[0]?.args).not.toHaveProperty('artifact_id');
    expect(onArtifactSaved).toHaveBeenCalledWith('audit-findings-task-1');
  });

  it('opens json artifacts directly in code view', async () => {
    readDiffMock = mock(async () => ({
      artifact: jsonArtifact,
      content: '{\n  "ok": true\n}\n',
      previousArtifact: null,
      previousContent: '',
      status: 'added',
    }));
    await loadArtifactDiffModal();
    ({ container, root } = await renderModal({
      artifactId: jsonArtifact.id,
      entries: [buildEntry(jsonArtifact)],
    }));

    expect(document.body.querySelector('[data-artifact-markdown-preview="true"]')).toBeNull();
    expect(findButton('Preview')).toBeUndefined();
    const editor = document.body.querySelector('[data-testid="artifact-code-editor"]') as HTMLTextAreaElement | null;
    expect(editor).not.toBeNull();
    expect(editor?.value).toContain('"ok": true');
  });

  it('hides edit and review actions in read-only context', async () => {
    ({ container, root } = await renderModal({
      artifactId: ownMarkdownArtifact.id,
      entries: [buildEntry(ownMarkdownArtifact)],
      context: 'readOnly',
      task: null,
    }));

    expect(readPlanDiffMock).toHaveBeenCalledTimes(1);
    expect(findButton('Edit')).toBeUndefined();
    expect(findButton('Validate artifact')).toBeUndefined();
    expect(findButton('Save')).toBeUndefined();
    expect(document.body.textContent).not.toContain('This artifact is stored in @macro.');
  });

  it('hides review status indicators in read-only context', async () => {
    ({ container, root } = await renderModal({
      artifactId: ownMarkdownArtifact.id,
      entries: [
        {
          ...buildEntry(ownMarkdownArtifact),
          review: {
            artifactId: ownMarkdownArtifact.id,
            taskId: task.id,
            validatedAt: '2026-01-01T00:00:00.000Z',
            validatedBy: 'user',
          },
          hasPendingReview: false,
          hasValidatedReview: true,
        },
      ],
      context: 'readOnly',
      task: null,
    }));

    expect(document.body.textContent).not.toContain('Validated');
    expect(document.body.querySelector('[data-pending-validation-indicator="true"]')).toBeNull();
  });

  it('keeps review status indicators visible in review context', async () => {
    ({ container, root } = await renderModal({
      artifactId: ownMarkdownArtifact.id,
      entries: [
        {
          ...buildEntry(ownMarkdownArtifact),
          review: {
            artifactId: ownMarkdownArtifact.id,
            taskId: task.id,
            validatedAt: '2026-01-01T00:00:00.000Z',
            validatedBy: 'user',
          },
          hasPendingReview: false,
          hasValidatedReview: true,
        },
      ],
    }));

    expect(document.body.textContent).toContain('Validated');
    expect(findButton('Unvalidate')).not.toBeUndefined();
  });

  it('shows expected placeholders when no artifact has been produced yet', async () => {
    ({ container, root } = await renderModal({
      artifactId: null,
      entries: [],
      expectedItems: [
        {
          id: 'task-1:api-contract',
          taskId: 'task-1',
          taskTitle: 'Current task',
          contract: {
            id: 'api-contract',
            title: 'API contract',
            kind: 'contract',
            required: true,
          },
        },
      ],
      context: 'readOnly',
      task: null,
    }));

    expect(readDiffMock).not.toHaveBeenCalled();
    expect(readPlanDiffMock).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('No produced artifacts yet.');
    expect(document.body.textContent).toContain('Produced artifacts will open here.');
    expect(document.body.textContent).toContain('API contract');
    expect(document.body.textContent).toContain('Expected');
    expect(document.body.querySelector('[title="API contract"]')).not.toBeNull();
    expect(document.body.textContent).not.toContain('{{count}} expected');
  });

  it('counts only produced artifacts in the modal sidebar summary', async () => {
    ({ container, root } = await renderModal({
      artifactId: ownMarkdownArtifact.id,
      entries: [buildEntry(ownMarkdownArtifact)],
      expectedItems: [
        {
          id: 'task-1:api-contract',
          taskId: 'task-1',
          taskTitle: 'Current task',
          contract: {
            id: 'api-contract',
            title: 'API contract',
            kind: 'contract',
            required: true,
          },
        },
      ],
      context: 'readOnly',
      task: null,
    }));

    expect(document.body.textContent).toContain('{{count}} produced');
    expect(document.body.textContent).not.toContain('{{count}} expected');
    expect(document.body.textContent).toContain('Expected');
    expect(document.body.textContent).toContain('API contract');
  });
});
