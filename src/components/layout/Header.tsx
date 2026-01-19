import { useAppStore } from '../../stores/useAppStore';
import { Icon } from '../ui/Icon';
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

  const modes: { value: AppMode; label: string }[] = [
    { value: 'Architect', label: 'Architect' },
    { value: 'Implement', label: 'Implement' },
  ];

  return (
    <header className="h-12 bg-zinc-900 border-b border-zinc-800 flex items-center px-4 shrink-0">
      {/* Left: Logo and App Name */}
      <div className="flex items-center gap-2 w-48">
        <Icon name="zap" size={20} className="text-indigo-500" />
        <span className="text-sm font-semibold text-zinc-100">Macro</span>
      </div>

      {/* Center: Mode Switch (Segment Control) */}
      <div className="flex-1 flex justify-center">
        <div className="inline-flex bg-zinc-800 rounded-lg p-1">
          {modes.map((m) => (
            <button
              key={m.value}
              onClick={() => setMode(m.value)}
              className={`
                px-4 py-1 rounded-md text-xs font-medium transition-all duration-200
                ${
                  mode === m.value
                    ? 'bg-indigo-500 text-white shadow-sm'
                    : 'text-zinc-400 hover:text-zinc-100 hover:bg-zinc-700/50'
                }
              `}
            >
              {m.label}
            </button>
          ))}
        </div>
      </div>

      {/* Right: Panel toggles */}
      <div className="w-48 flex items-center justify-end gap-2">
        <button
          onClick={onToggleLeft}
          className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
        >
          <Icon
            name={isLeftOpen ? 'panel-left-close' : 'panel-left-open'}
            size={16}
            className="text-zinc-400"
          />
        </button>
        <button
          onClick={onToggleRight}
          className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
        >
          <Icon
            name={isRightOpen ? 'panel-right-close' : 'panel-right-open'}
            size={16}
            className="text-zinc-400"
          />
        </button>
      </div>
    </header>
  );
}
