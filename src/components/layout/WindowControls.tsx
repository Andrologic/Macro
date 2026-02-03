import { Icon } from '../ui/Icon';
import { useTauriWindow } from '../../hooks/useTauriWindow';

export function WindowControls() {
  const { isAvailable, isMaximized, minimize, maximize, unmaximize, close } = useTauriWindow();

  // Don't render window controls in web mode
  if (!isAvailable) {
    return null;
  }

  const handleMaximize = () => {
    if (isMaximized) {
      unmaximize();
    } else {
      maximize();
    }
  };

  return (
    <div className="flex items-center gap-0.5">
      {/* Minimize Button */}
      <button
        onClick={minimize}
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
        onClick={close}
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
