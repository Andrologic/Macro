import { useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Icon } from '../ui/Icon';

export function WindowControls() {
  // Check if Tauri API is available
  const isTauriAvailable = typeof window !== 'undefined' && window.__TAURI__;
  const tauriWindow = isTauriAvailable ? getCurrentWindow() : null;
  const [isMaximized, setIsMaximized] = useState(false);

  const handleMinimize = () => {
    if (tauriWindow) {
      tauriWindow.minimize();
    }
  };

  const handleMaximize = () => {
    if (tauriWindow) {
      tauriWindow.toggleMaximize();
      setIsMaximized(!isMaximized);
    }
  };

  const handleClose = () => {
    if (tauriWindow) {
      tauriWindow.close();
    }
  };

  // Don't render window controls in web mode
  if (!isTauriAvailable) {
    return null;
  }

  return (
    <div className="flex items-center gap-0.5">
      {/* Minimize Button */}
      <button
        onClick={handleMinimize}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent transition-colors group active:scale-[0.98]"
        title="Minimize"
        data-tauri-drag-region="false"
      >
        <Icon
          name="minus"
          size={14}
          className="text-muted-foreground group-hover:text-foreground transition-colors"
        />
      </button>

      {/* Maximize Button */}
      <button
        onClick={handleMaximize}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent transition-colors group active:scale-[0.98]"
        title={isMaximized ? 'Restore' : 'Maximize'}
        data-tauri-drag-region="false"
      >
        <Icon
          name="maximize"
          size={14}
          className="text-muted-foreground group-hover:text-foreground transition-colors"
        />
      </button>

      {/* Close Button */}
      <button
        onClick={handleClose}
        className="w-8 h-8 flex items-center justify-center rounded-lg hover:bg-accent transition-colors group active:scale-[0.98]"
        title="Close"
        data-tauri-drag-region="false"
      >
        <Icon
          name="x"
          size={14}
          className="text-muted-foreground group-hover:text-foreground transition-colors"
        />
      </button>
    </div>
  );
}
