import React, { useEffect, useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { blueprintFolderId, removeBlueprintFolder, type BlueprintFolder, type BlueprintFolderOrganization } from '../../services/blueprintFolders';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import type { ArchitectNavigatorPlanEntry } from './architectProjectNavigatorModel';

export const BLUEPRINT_DRAG_TYPE = 'application/x-macro-blueprint';
interface Props {
  scopeId: string;
  entries: ArchitectNavigatorPlanEntry[];
  organization: BlueprintFolderOrganization;
  disabled: boolean;
  searching: boolean;
  draggedPlan: ArchitectNavigatorPlanEntry | null;
  onDragChange: (entry: ArchitectNavigatorPlanEntry | null) => void;
  onDropPlan: (scopeId: string, folderId: string | null, event: React.DragEvent) => void;
  onUpdate: (next: BlueprintFolderOrganization) => Promise<boolean>;
  onRename: (folder: BlueprintFolder) => void;
  renderPlan: (entry: ArchitectNavigatorPlanEntry) => React.ReactNode;
  children?: React.ReactNode;
}
export function BlueprintFolderTree({ scopeId, entries, organization, disabled, searching, draggedPlan, onDragChange, onDropPlan, onUpdate, onRename, renderPlan, children }: Props) {
  const { t } = useTranslation();
  const contentId = useId();
  const [menuId, setMenuId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const folders = organization.folders.filter(f => f.scopeId === scopeId);
  const canDrop = !disabled && draggedPlan?.scopeId === scopeId;
  useEffect(() => {
    if (!menuId) return;
    const close = (event: Event) => {
      if (event instanceof KeyboardEvent && event.key !== 'Escape') return;
      if (event.type !== 'keydown' && event.target instanceof Element && event.target.closest('[data-blueprint-folder-menu]')) return;
      setMenuId(null);
    };
    document.addEventListener('pointerdown', close);
    document.addEventListener('keydown', close);
    return () => { document.removeEventListener('pointerdown', close); document.removeEventListener('keydown', close); };
  }, [menuId]);
  const row = (entry: ArchitectNavigatorPlanEntry) => (
    <div key={entry.locatorKey} data-blueprint-locator={entry.locatorKey}
      draggable={!disabled}
      className={cn(draggedPlan?.locatorKey === entry.locatorKey && 'opacity-40')}
      onDragStart={event => {
        // Buttons retain their click behavior. Only the plan row initiates a move.
        if (disabled) { event.preventDefault(); return; }
        event.stopPropagation();
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData(BLUEPRINT_DRAG_TYPE, JSON.stringify({ scopeId, locatorKey: entry.locatorKey }));
        onDragChange(entry);
      }}
      onDragEnd={() => { onDragChange(null); setHoveredId(null); }}
    >{renderPlan(entry)}</div>
  );
  return <>
    {folders.map(folder => {
      const plans = entries.filter(entry => blueprintFolderId(organization, scopeId, entry.locatorKey) === folder.id);
      if (searching && plans.length === 0) return null;
      const expanded = searching || !organization.collapsedIds.includes(folder.id);
      const id = `${contentId}-${folder.id}`;
      return <div key={folder.id} data-blueprint-folder={folder.id}
          onDragOver={event => { if (canDrop) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setHoveredId(folder.id); } }}
          onDragLeave={() => setHoveredId(null)}
          onDrop={event => { setHoveredId(null); onDropPlan(scopeId, folder.id, event); }}
        >
        <div className={cn('group/folder relative flex min-h-8 items-center rounded-md text-muted-foreground hover:bg-accent/45', canDrop && hoveredId === folder.id && 'bg-primary/10 ring-1 ring-inset ring-primary/60')}
        >
          <button type="button" aria-expanded={expanded} aria-controls={id}
            onClick={() => { void onUpdate({ ...organization, collapsedIds: expanded ? [...organization.collapsedIds, folder.id] : organization.collapsedIds.filter(value => value !== folder.id) }); }}
            disabled={disabled}
            className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded px-1.5 text-left text-xs hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary/70 disabled:opacity-50">
            <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={11} />
            <Icon name={expanded ? 'folder-open' : 'folder'} size={13} className="shrink-0 opacity-75" />
            <span className="truncate">{folder.name}</span>
          </button>
          <div className="relative" data-blueprint-folder-menu>
            <button type="button" aria-label={t('architect.projectNavigator.folderActions', { name: folder.name, defaultValue: 'Actions for {{name}}' })} aria-expanded={menuId === folder.id} disabled={disabled}
              onClick={() => setMenuId(menuId === folder.id ? null : folder.id)}
              className="mr-1 flex h-6 w-6 items-center justify-center rounded opacity-0 hover:bg-background focus-visible:opacity-100 group-hover/folder:opacity-100 group-focus-within/folder:opacity-100">
              <Icon name="more-horizontal" size={12} />
            </button>
            {menuId === folder.id && <div role="menu" className="absolute right-0 top-7 z-30 w-44 rounded-lg border border-border bg-popover p-1 text-xs text-popover-foreground shadow-xl">
              <button type="button" role="menuitem" onClick={() => { setMenuId(null); onRename(folder); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"><Icon name="edit" size={11} />{t('common.rename')}</button>
              <button type="button" role="menuitem" onClick={() => { setMenuId(null); void onUpdate(removeBlueprintFolder(organization, folder.id)); }} title={t('architect.projectNavigator.removeFolderHelp', 'Blueprints remain in the project.')} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent"><Icon name="trash" size={11} />{t('architect.projectNavigator.removeFolder', 'Remove folder')}</button>
            </div>}
          </div>
        </div>
        {expanded && <div id={id} className="ml-5 space-y-0.5 border-l border-border/50 pl-1">
          {plans.map(row)}
          {plans.length === 0 && <p className="px-2 py-2 text-[10px] text-muted-foreground/65">{t('architect.projectNavigator.emptyFolder', 'Drop a blueprint here')}</p>}
        </div>}
      </div>;
    })}
    {entries.filter(entry => !blueprintFolderId(organization, scopeId, entry.locatorKey)).map(row)}
    {folders.length === 0 && entries.length === 0 && children}
  </>;
}
