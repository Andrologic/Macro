import { useState } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon, IconName } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { WindowControls } from './WindowControls';
import { useTauriWindow } from '../../hooks/useTauriWindow';
import { useTranslation } from 'react-i18next';
import { ProjectNavigator } from '../modals/ProjectNavigator';
import { cn } from '../../utils/cn';
import type { AppMode } from '../../types';

interface HeaderProps {
  isLeftOpen: boolean;
  isRightOpen: boolean;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}

export function Header({
  isLeftOpen,
  isRightOpen,
  onToggleLeft,
  onToggleRight,
}: HeaderProps) {
  const mode = useAppStore((state) => state.mode);
  const setMode = useAppStore((state) => state.setMode);
  const openSettings = useAppStore((state) => state.openSettings);
  const openAccount = useAppStore((state) => state.openAccount);
  const selectedProjectId = useAppStore((state) => state.selectedProjectId);
  const selectedGroupId = useAppStore((state) => state.selectedGroupId);
  const projectGroups = useAppStore((state) => state.projectGroups);
  const { isAvailable: isTauriAvailable, toggleMaximize } = useTauriWindow();
  const { t } = useTranslation();
  
  const [projectNavigatorOpen, setProjectNavigatorOpen] = useState(false);

  const handleHeaderDoubleClick = () => {
    if (isTauriAvailable) {
      toggleMaximize();
    }
  };

  const modes: { value: AppMode; label: string; icon: IconName }[] = [
    { value: 'Architect', label: t('header.architect'), icon: 'compass' },
    { value: 'Implement', label: t('header.implement'), icon: 'code' },
    { value: 'Chat', label: t('header.chat'), icon: 'message-circle' },
  ];

  // Get current project/group name for display
  const getCurrentProjectName = () => {
    if (!selectedGroupId) return null;
    const group = projectGroups.find(g => g.id === selectedGroupId);
    if (!group) return null;
    
    if (selectedProjectId) {
      const project = group.projects.find(p => p.id === selectedProjectId);
      return project?.name || group.name;
    }
    return group.name;
  };

  const projectName = getCurrentProjectName();

  return (
    <>
      <header 
        className="h-12 bg-card border-b border-border flex items-center px-4 shrink-0 select-none relative z-50"
        data-tauri-drag-region
        onDoubleClick={handleHeaderDoubleClick}
      >
        {/* Left: Logo, App Name, and Project Button */}
        <div className="flex items-center gap-3 min-w-[200px]" data-tauri-drag-region>
          <div className="flex items-center gap-2">
            <Logo size={20} strokeWidth={3} />
            <span className="text-sm font-semibold text-foreground">Macro</span>
          </div>
          
          {/* Project Button - Hidden in Chat mode */}
          {mode !== 'Chat' && (
            <>
              <div className="w-px h-5 bg-border" />
              <button
                onClick={() => setProjectNavigatorOpen(true)}
                className={cn(
                  "flex items-center gap-2 px-3 py-1.5 rounded-lg",
                  "hover:bg-accent transition-colors",
                  "text-sm max-w-[180px]"
                )}
                data-tauri-drag-region="false"
              >
                <Icon name="folder-git-2" size={14} className="text-muted-foreground shrink-0" />
                <span className="truncate text-foreground">
                  {projectName || t('header.selectProject')}
                </span>
                <Icon name="chevron-down" size={12} className="text-muted-foreground shrink-0" />
              </button>
            </>
          )}
        </div>

        {/* Center: Mode Switch (Segment Control) */}
        <div className="flex-1 flex justify-center" data-tauri-drag-region>
          <div className="inline-flex bg-secondary rounded-lg p-1">
            {modes.map((m) => (
              <button
                key={m.value}
                onClick={() => setMode(m.value)}
                data-tauri-drag-region="false"
                className={cn(
                  "flex items-center gap-1.5 px-3 py-1 rounded-md text-xs font-medium transition-all duration-200",
                  mode === m.value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                )}
              >
                <Icon name={m.icon} size={12} />
                {m.label}
              </button>
            ))}
          </div>
        </div>

        {/* Right: Panel toggles, settings, and account */}
        <div className="min-w-[200px] flex items-center justify-end gap-2" data-tauri-drag-region>
          {/* Panel toggles */}
          <button
            onClick={onToggleLeft}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            data-tauri-drag-region="false"
          >
            <Icon
              name={isLeftOpen ? 'panel-left-close' : 'panel-left-open'}
              size={16}
              className="text-muted-foreground"
            />
          </button>
          <button
            onClick={onToggleRight}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            data-tauri-drag-region="false"
          >
            <Icon
              name={isRightOpen ? 'panel-right-close' : 'panel-right-open'}
              size={16}
              className="text-muted-foreground"
            />
          </button>

          {/* Divider */}
          <div className="w-px h-5 bg-border mx-1" />

          {/* Settings button */}
          <button
            onClick={openSettings}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            title={t('header.settings')}
            aria-label={t('header.settings')}
            data-tauri-drag-region="false"
          >
            <Icon name="settings" size={16} className="text-muted-foreground" />
          </button>

          {/* Account button */}
          <button
            onClick={openAccount}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            title={t('header.account')}
            aria-label={t('header.account')}
            data-tauri-drag-region="false"
          >
            <Icon name="user" size={16} className="text-muted-foreground" />
          </button>

          {/* Divider before window controls - only show in Tauri mode */}
          {isTauriAvailable && <div className="w-px h-5 bg-border mx-1" />}

          {/* Window Controls */}
          <WindowControls />
        </div>
      </header>

      {/* Project Navigator Modal */}
      <ProjectNavigator 
        isOpen={projectNavigatorOpen} 
        onClose={() => setProjectNavigatorOpen(false)} 
      />
    </>
  );
}
