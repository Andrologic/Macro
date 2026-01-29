import type { MouseEvent } from 'react';
import { useRef } from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
import { Logo } from '../ui/Logo';
import { WindowControls } from './WindowControls';
import { useTauriWindow } from '../../hooks/useTauriWindow';
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
  const { isAvailable: isTauriAvailable, toggleMaximize, startDragging } = useTauriWindow();
  
  const lastClickTimeRef = useRef<number>(0);
  const DOUBLE_CLICK_DELAY = 300;

  const handleHeaderMouseDown = (event: MouseEvent<HTMLElement>) => {
    if (!isTauriAvailable || event.button !== 0) {
      return;
    }

    const target = event.target as HTMLElement | null;
    const isInteractiveTarget = !!target?.closest('[data-tauri-drag-region="false"]');

    if (isInteractiveTarget) {
      return;
    }

    const now = Date.now();
    const timeSinceLastClick = now - lastClickTimeRef.current;

    if (timeSinceLastClick < DOUBLE_CLICK_DELAY) {
      // Double-click detected
      lastClickTimeRef.current = 0;
      toggleMaximize();
    } else {
      // Single click - start dragging
      lastClickTimeRef.current = now;
      startDragging();
    }
  };

  const modes: { value: AppMode; label: string }[] = [
    { value: 'Architect', label: 'Architect' },
    { value: 'Implement', label: 'Implement' },
  ];

  return (
    <header 
      className="h-12 bg-card border-b border-border flex items-center px-4 shrink-0 select-none"
      data-tauri-drag-region
      onMouseDown={handleHeaderMouseDown}
    >
      {/* Left: Logo and App Name */}
      <div className="flex items-center gap-2 w-48">
        <Logo size={20} strokeWidth={3} />
        <span className="text-sm font-semibold text-foreground">Macro</span>
      </div>

      {/* Center: Mode Switch (Segment Control) */}
      <div className="flex-1 flex justify-center">
        <div className="inline-flex bg-secondary rounded-lg p-1">
          {modes.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              data-tauri-drag-region="false"
              className={`
                px-4 py-1 rounded-md text-xs font-medium transition-all duration-200
                ${
                  mode === m.value
                    ? 'bg-primary text-primary-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground hover:bg-accent/50'
                }
              `}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Right: Panel toggles, settings, and account */}
      <div className="w-48 flex items-center justify-end gap-2">
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
          title="Settings"
          data-tauri-drag-region="false"
        >
          <Icon name="settings" size={16} className="text-muted-foreground" />
        </button>

        {/* Account button */}
        <button
          onClick={openAccount}
          className="p-1.5 rounded-lg hover:bg-accent transition-colors"
          title="Account"
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
  );
}
