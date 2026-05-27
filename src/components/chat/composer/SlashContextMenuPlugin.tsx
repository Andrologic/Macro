import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import {
  $createTextNode,
  $getNodeByKey,
  $getSelection,
  $isRangeSelection,
  $isTextNode,
  COMMAND_PRIORITY_CRITICAL,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_ESCAPE_COMMAND,
  KEY_TAB_COMMAND,
} from 'lexical';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import {
  NEED_CATEGORY_COLORS,
  NEED_CATEGORY_ICONS,
} from '../../architect/NeedReferenceChip';
import { useAppStore } from '../../../stores/useAppStore';
import { useChatStore } from '../../../stores/useChatStore';
import { useNeedsStore } from '../../../stores/useNeedsStore';
import { useSkillsStore } from '../../../stores/useSkillsStore';
import { useTaskStore } from '../../../stores/useTaskStore';
import { resolveProjectExecutionContext } from '../../../services/projectExecutionContext';
import { searchWorkspaceFiles } from '../../../services/workspaceFileSearch';
import type { ContextRefKind, Need, SkillManifest, WorkspaceFileReference } from '../../../types';
import { cn } from '../../../utils/cn';
import { Icon, type IconName } from '../../ui/Icon';
import { $createMentionNode } from './MentionNode';
import {
  hasFileQueryIntent,
  rankSlashContextCandidates,
  type SlashContextRankCandidate,
} from './slashContextRanking';

interface SlashTriggerState {
  nodeKey: string;
  startOffset: number;
  endOffset: number;
  query: string;
  rect: DOMRect;
}

type SlashContextKind = 'need' | 'skill' | 'file';

interface SlashContextMenuItem extends SlashContextRankCandidate {
  key: string;
  kind: SlashContextKind;
  refKind: ContextRefKind;
  id: string;
  title: string;
  subtitle?: string;
  referenceTitle?: string;
  tooltip?: string;
  icon: IconName;
  iconClassName?: string;
  label?: string;
  searchText: string;
  disabled?: boolean;
  data: Need | SkillManifest | WorkspaceFileReference;
  score?: number;
}

interface SlashContextUsageRecord {
  useCount: number;
  lastUsedAt: number;
}

const SLASH_CONTEXT_USAGE_KEY = 'macro.slashContextUsage.v1';
const MAX_SLASH_ITEMS = 8;
const SLASH_MENU_WIDTH = 416;

const loadSlashContextUsage = (): Record<string, SlashContextUsageRecord> => {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(SLASH_CONTEXT_USAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object') return {};
    return parsed as Record<string, SlashContextUsageRecord>;
  } catch {
    return {};
  }
};

const recordSlashContextUsage = (key: string) => {
  if (typeof window === 'undefined') return;
  const usage = loadSlashContextUsage();
  const previous = usage[key] ?? { useCount: 0, lastUsedAt: 0 };
  usage[key] = {
    useCount: previous.useCount + 1,
    lastUsedAt: Date.now(),
  };
  try {
    window.localStorage.setItem(SLASH_CONTEXT_USAGE_KEY, JSON.stringify(usage));
  } catch {
    // Best-effort ranking signal; ignore storage failures.
  }
};

const getCaretRect = (editorRoot: HTMLElement | null): DOMRect | null => {
  const selection = window.getSelection();
  const range = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  const rect = range?.getBoundingClientRect();
  if (rect && (rect.width > 0 || rect.height > 0)) {
    return rect;
  }

  const firstRect = range?.getClientRects()[0];
  if (firstRect) {
    return firstRect;
  }

  return editorRoot?.getBoundingClientRect() ?? null;
};

const formatNamespaceLabel = (
  skill: SkillManifest,
  t: (key: string, fallback: string) => string,
): string => {
  switch (skill.source.namespace) {
    case 'codex':
      return t('skills.source.codex', 'Codex');
    case 'opencode':
      return t('skills.source.opencode', 'OpenCode');
    case 'claude':
      return t('skills.source.claude', 'Claude');
    case 'agents':
    default:
      return t('skills.source.agents', 'Agents');
  }
};

const formatScopeLabel = (
  skill: SkillManifest,
  t: (key: string, fallback: string) => string,
): string =>
  skill.source.kind === 'project'
    ? skill.source.projectName || t('skills.projectSource', 'Project')
    : t('skills.globalSource', 'Global');

const formatSourceLabel = (
  skill: SkillManifest,
  t: (key: string, fallback: string) => string,
): string => `${formatNamespaceLabel(skill, t)} · ${formatScopeLabel(skill, t)}`;

const getNeedSubtitle = (need: Need): string | undefined =>
  need.description.trim() ? need.description : undefined;

const getPathBasename = (path: string): string => {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || path;
};

const formatFileLocation = (file: WorkspaceFileReference): string => {
  const relativePath = file.relativePath || file.path;
  return file.projectName ? `${file.projectName}/${relativePath}` : file.path;
};

export const SlashContextMenuPlugin: React.FC = () => {
  const { t } = useTranslation();
  const [editor] = useLexicalComposerContext();
  const menuRef = useRef<HTMLDivElement>(null);
  const wasOpenRef = useRef(false);
  const fileSearchRequestRef = useRef(0);
  const [trigger, setTrigger] = useState<SlashTriggerState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [fileResults, setFileResults] = useState<WorkspaceFileReference[]>([]);
  const [isSearchingFiles, setIsSearchingFiles] = useState(false);
  const [slashUsage, setSlashUsage] = useState<Record<string, SlashContextUsageRecord>>(
    () => loadSlashContextUsage(),
  );

  const mode = useAppStore((state) => state.mode);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedTaskId = useAppStore((state) => state.selectedTaskId);
  const activeArchitectPlanId = useAppStore((state) => state.activeArchitectPlanId);
  const selectedConversationId = useChatStore((state) => state.selectedConversationId);
  const conversations = useChatStore((state) => state.conversations);
  const allNeeds = useNeedsStore((state) => state.needs);
  const allSkills = useSkillsStore((state) => state.skills);
  const settingsBySkillId = useSkillsStore((state) => state.settingsBySkillId);
  const isLoadingSkills = useSkillsStore((state) => state.isLoading);
  const loadSettings = useSkillsStore((state) => state.loadSettings);
  const refreshSkills = useSkillsStore((state) => state.refreshSkills);
  const composerContextRefs = useChatStore((state) => state.composerContextRefs);
  const tasks = useTaskStore((state) => state.tasks);
  const activeRepositoryPath = useTaskStore((state) => state.activeRepositoryPath);
  const activeWorkspacePathOverridesByProjectId = useTaskStore(
    (state) => state.activeWorkspacePathOverridesByProjectId,
  );
  const branchWorktrees = useTaskStore((state) => state.branchWorktrees);

  const executionContext = useMemo(
    () =>
      resolveProjectExecutionContext({
        mode,
        projects: projectGroups.flatMap((group) => group.projects),
        projectGroups,
        tasks,
        conversations,
        conversationId: selectedConversationId,
        selectedGroupId,
        selectedProjectId,
        selectedTaskId,
        activeRepositoryPath,
        workspacePathOverridesByProjectId: activeWorkspacePathOverridesByProjectId,
        branchWorktrees,
      }),
    [
      activeRepositoryPath,
      activeWorkspacePathOverridesByProjectId,
      branchWorktrees,
      conversations,
      mode,
      projectGroups,
      selectedConversationId,
      selectedGroupId,
      selectedProjectId,
      selectedTaskId,
      tasks,
    ],
  );

  useEffect(() => {
    void loadSettings();
  }, [loadSettings]);

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          setTrigger(null);
          return;
        }

        const anchor = selection.anchor;
        if (anchor.type !== 'text') {
          setTrigger(null);
          return;
        }

        const node = anchor.getNode();
        if (!$isTextNode(node)) {
          setTrigger(null);
          return;
        }

        const endOffset = anchor.offset;
        const textBeforeCaret = node.getTextContent().slice(0, endOffset);
        const match = /(?:^|\s)\/([^\s/]*)$/.exec(textBeforeCaret);
        if (!match) {
          setTrigger(null);
          return;
        }

        const slashIndex = textBeforeCaret.lastIndexOf('/');
        const rect = getCaretRect(editor.getRootElement());
        if (!rect) {
          setTrigger(null);
          return;
        }

        setTrigger({
          nodeKey: node.getKey(),
          startOffset: slashIndex,
          endOffset,
          query: match[1] ?? '',
          rect,
        });
      });
    });
  }, [editor]);

  useEffect(() => {
    if (trigger && !wasOpenRef.current) {
      wasOpenRef.current = true;
      setActiveIndex(0);
      void refreshSkills();
    } else if (!trigger) {
      wasOpenRef.current = false;
    }
  }, [refreshSkills, trigger]);

  const selectedRefKeys = useMemo(
    () => new Set(composerContextRefs.map((ref) => `${ref.kind}:${ref.id}`)),
    [composerContextRefs],
  );

  useEffect(() => {
    const query = trigger?.query.trim() ?? '';
    const shouldSearchFiles =
      Boolean(trigger) &&
      Boolean(executionContext.workspacePath || executionContext.projectMounts.length > 0) &&
      (query.length >= 2 || hasFileQueryIntent(query));

    if (!shouldSearchFiles) {
      fileSearchRequestRef.current += 1;
      setFileResults([]);
      setIsSearchingFiles(false);
      return undefined;
    }

    const requestId = fileSearchRequestRef.current + 1;
    fileSearchRequestRef.current = requestId;
    setIsSearchingFiles(true);

    const timeoutId = window.setTimeout(() => {
      void searchWorkspaceFiles({
        executionContext,
        query,
        limit: 30,
        includeHidden: false,
      })
        .then((results) => {
          if (fileSearchRequestRef.current === requestId) {
            setFileResults(results);
          }
        })
        .catch((error) => {
          console.warn('Failed to search workspace files for slash menu:', error);
          if (fileSearchRequestRef.current === requestId) {
            setFileResults([]);
          }
        })
        .finally(() => {
          if (fileSearchRequestRef.current === requestId) {
            setIsSearchingFiles(false);
          }
        });
    }, 120);

    return () => window.clearTimeout(timeoutId);
  }, [executionContext, trigger]);

  const menuItems = useMemo<SlashContextMenuItem[]>(() => {
    const query = trigger?.query.trim() ?? '';
    const activeNeeds = activeArchitectPlanId
      ? allNeeds.filter((need) => need.planId === activeArchitectPlanId)
      : [];

    const needItems: SlashContextMenuItem[] = activeNeeds.map((need) => {
      const categoryLabel = t(`architect.needCategory.${need.category}`, need.category);
      const key = `need:${need.id}`;
      return {
        key,
        kind: 'need',
        refKind: 'need',
        id: need.id,
        title: need.title,
        subtitle: getNeedSubtitle(need),
        icon: NEED_CATEGORY_ICONS[need.category],
        iconClassName: NEED_CATEGORY_COLORS[need.category],
        label: categoryLabel,
        searchText: [
          need.title,
          need.description,
          need.category,
          need.priority,
          need.status,
          ...need.tags,
        ].join(' '),
        useCount: slashUsage[key]?.useCount,
        lastUsedAt: slashUsage[key]?.lastUsedAt,
        data: need,
      };
    });

    const skillItems: SlashContextMenuItem[] = allSkills
      .filter((skill) => {
        if (!skill.isValid) return false;
        const enabled = settingsBySkillId[skill.id]?.enabled === true;
        return enabled || query.length > 0;
      })
      .map((skill) => {
        const namespaceLabel = formatNamespaceLabel(skill, t);
        const scopeLabel = formatScopeLabel(skill, t);
        const enabled = settingsBySkillId[skill.id]?.enabled === true;
        const key = `skill:${skill.id}`;
        return {
          key,
          kind: 'skill',
          refKind: 'skill',
          id: skill.id,
          title: skill.name,
          subtitle: formatSourceLabel(skill, t),
          icon: 'sparkles',
          iconClassName: 'text-fuchsia-400',
          label: `${namespaceLabel} · ${scopeLabel}`,
          searchText: [
            skill.name,
            skill.description,
            namespaceLabel,
            scopeLabel,
            skill.id,
            skill.compatibility ?? '',
            skill.allowedTools ?? '',
            skill.shadowedBySkillId ?? '',
          ].join(' '),
          disabled: !enabled,
          skillEnabled: enabled,
          useCount: slashUsage[key]?.useCount,
          lastUsedAt: slashUsage[key]?.lastUsedAt,
          data: skill,
        };
      });

    const fileItems: SlashContextMenuItem[] = fileResults.map((file) => {
      const key = `file:${file.id}`;
      const location = formatFileLocation(file);
      return {
        key,
        kind: 'file',
        refKind: 'file',
        id: file.id,
        title: getPathBasename(file.path),
        subtitle: location,
        referenceTitle: file.path,
        tooltip: location,
        icon: 'file-text',
        iconClassName: 'text-blue-400',
        label: location,
        searchText: [
          file.path,
          file.relativePath,
          file.projectName ?? '',
          file.language ?? '',
        ].join(' '),
        isFocusedFile: file.isFocused,
        useCount: slashUsage[key]?.useCount,
        lastUsedAt: slashUsage[key]?.lastUsedAt,
        data: file,
      };
    });

    return rankSlashContextCandidates(
      [...needItems, ...skillItems, ...fileItems],
      {
        query,
        mode,
        hasActivePlan: Boolean(activeArchitectPlanId),
      },
    ).slice(0, MAX_SLASH_ITEMS);
  }, [
    activeArchitectPlanId,
    allNeeds,
    allSkills,
    fileResults,
    mode,
    settingsBySkillId,
    slashUsage,
    t,
    trigger?.query,
  ]);

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(menuItems.length - 1, 0)));
  }, [menuItems.length]);

  const closeMenu = useCallback(() => {
    setTrigger(null);
    setActiveIndex(0);
  }, []);

  useEffect(() => {
    if (!trigger) return undefined;
    const handleMouseDown = (event: MouseEvent) => {
      if (menuRef.current?.contains(event.target as Node)) return;
      closeMenu();
    };

    document.addEventListener('mousedown', handleMouseDown);
    return () => document.removeEventListener('mousedown', handleMouseDown);
  }, [closeMenu, trigger]);

  const openSkillsSettings = useCallback(() => {
    useAppStore.getState().openSettings('skills');
    closeMenu();
  }, [closeMenu]);

  const insertItem = useCallback((item: SlashContextMenuItem) => {
    if (!trigger || item.disabled) return;
    const referenceTitle = item.referenceTitle ?? item.title;
    let didInsertMention = false;

    editor.update(() => {
      const node = $getNodeByKey(trigger.nodeKey);
      if (!$isTextNode(node)) return;

      const mentionNode = $createMentionNode(item.refKind, item.id, referenceTitle);
      const selection = node.select(trigger.startOffset, trigger.endOffset);
      selection.insertNodes([mentionNode, $createTextNode(' ')]);
      didInsertMention = true;
    });

    if (!didInsertMention) return;

    useChatStore.getState().addComposerContextRef({
      id: item.id,
      kind: item.refKind,
      title: referenceTitle,
      subtitle: item.subtitle,
      data: item.data,
    });
    recordSlashContextUsage(item.key);
    setSlashUsage(loadSlashContextUsage());
    closeMenu();
    editor.focus();
  }, [closeMenu, editor, trigger]);

  useEffect(() => {
    if (!trigger) return undefined;

    return editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        event.preventDefault();
        setActiveIndex((index) => Math.min(index + 1, Math.max(menuItems.length - 1, 0)));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor, menuItems.length, trigger]);

  useEffect(() => {
    if (!trigger) return undefined;

    return editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event: KeyboardEvent) => {
        event.preventDefault();
        setActiveIndex((index) => Math.max(index - 1, 0));
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [editor, trigger]);

  useEffect(() => {
    if (!trigger) return undefined;

    return editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event: KeyboardEvent | null) => {
        event?.preventDefault();
        const item = menuItems[activeIndex];
        if (item && !item.disabled) {
          insertItem(item);
        }
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [activeIndex, editor, insertItem, menuItems, trigger]);

  useEffect(() => {
    if (!trigger) return undefined;

    return editor.registerCommand(
      KEY_TAB_COMMAND,
      (event: KeyboardEvent) => {
        event.preventDefault();
        event.stopImmediatePropagation();
        const item = menuItems[activeIndex];
        if (item && !item.disabled) {
          insertItem(item);
        }
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [activeIndex, editor, insertItem, menuItems, trigger]);

  useEffect(() => {
    if (!trigger) return undefined;

    return editor.registerCommand(
      KEY_ESCAPE_COMMAND,
      (event: KeyboardEvent) => {
        event.preventDefault();
        closeMenu();
        return true;
      },
      COMMAND_PRIORITY_CRITICAL,
    );
  }, [closeMenu, editor, trigger]);

  if (!trigger) return null;

  const menu = (
    <div
      ref={menuRef}
      data-slash-context-menu="true"
      className="fixed z-50 w-[26rem] max-w-[calc(100vw-1rem)] overflow-hidden rounded-xl border border-border/80 bg-card/95 p-1 text-sm shadow-xl backdrop-blur"
      style={{
        left: Math.max(8, Math.min(trigger.rect.left, window.innerWidth - SLASH_MENU_WIDTH - 8)),
        top: trigger.rect.top - 8,
        transform: 'translateY(-100%)',
      }}
      onMouseDown={(event) => event.preventDefault()}
    >
      <div className="max-h-72 overflow-y-auto">
        {(isLoadingSkills || isSearchingFiles) && menuItems.length === 0 ? (
          <div className="flex items-center gap-2 rounded-lg px-2.5 py-2 text-muted-foreground">
            <Icon name="loader" size={13} className="animate-spin" />
            {isSearchingFiles
              ? t('composer.searchingFiles', 'Searching files...')
              : t('skills.loading', 'Loading skills...')}
          </div>
        ) : menuItems.length === 0 ? (
          <div className="space-y-2 rounded-lg px-2.5 py-2 text-muted-foreground">
            <div className="text-sm">
              {trigger.query
                ? t('composer.noMatchingSlashContext', 'No matching context.')
                : t('composer.noSlashContext', 'No context available.')}
            </div>
            <button
              type="button"
              onClick={openSkillsSettings}
              aria-label={t('skills.openSettings', 'Open Settings')}
              className="flex h-7 w-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <Icon name="settings" size={13} />
            </button>
          </div>
        ) : (
          menuItems.map((item, index) => {
            const selected = selectedRefKeys.has(`${item.refKind}:${item.id}`);
            const active = index === activeIndex;
            const optionKey = `${item.kind}:${item.referenceTitle ?? item.title}`;
            const tooltip = item.tooltip ?? item.subtitle ?? item.label ?? item.title;

            if (item.disabled) {
              return (
                <div
                  key={item.key}
                  data-slash-context-option={optionKey}
                  title={tooltip}
                  className={cn(
                    'grid w-full grid-cols-[1.75rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-muted-foreground/70',
                    'min-h-10',
                    active && 'bg-accent/60',
                  )}
                >
                  <span className="relative flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70">
                    <Icon
                      name={item.icon}
                      size={14}
                      className={cn('shrink-0', item.iconClassName)}
                    />
                    <span className="absolute -right-1 -top-1 flex h-3.5 w-3.5 items-center justify-center rounded-full border border-card bg-muted">
                      <Icon name="lock" size={8} />
                    </span>
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-medium leading-5" title={item.title}>
                      {item.title}
                    </span>
                    <span className="block truncate text-xs leading-4 opacity-80" title={tooltip}>
                      {item.label}
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={openSkillsSettings}
                    aria-label={t('skills.openSettings', 'Open Settings')}
                    className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                  >
                    <Icon name="settings" size={13} />
                  </button>
                </div>
              );
            }

            return (
              <button
                key={item.key}
                type="button"
                data-slash-context-option={optionKey}
                aria-selected={active}
                title={tooltip}
                onClick={() => insertItem(item)}
                className={cn(
                  'grid w-full grid-cols-[1.75rem_minmax(0,1fr)_1.5rem] items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors',
                  'min-h-10',
                  active
                    ? 'bg-accent text-foreground'
                    : 'text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted/70">
                  <Icon
                    name={item.icon}
                    size={14}
                    className={cn('shrink-0', item.iconClassName)}
                  />
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium leading-5" title={item.title}>
                    {item.title}
                  </span>
                  <span className="block truncate text-xs leading-4 text-muted-foreground" title={tooltip}>
                    {item.label ?? item.subtitle}
                  </span>
                </span>
                <span className="flex h-6 w-6 shrink-0 items-center justify-center">
                  {selected && <Icon name="check" size={14} className="shrink-0" />}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
  );

  return createPortal(menu, document.body);
};
