import React, { useState } from 'react';
import type { MacroExtensionComposerContribution } from '../../services/extensions';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

interface ExtensionComposerProps {
  composer: MacroExtensionComposerContribution;
}

export const ExtensionComposer: React.FC<ExtensionComposerProps> = ({ composer }) => {
  const modes = composer.modes ?? [];
  const defaultMode = composer.defaultMode ?? modes[0]?.id ?? '';
  const [activeMode, setActiveMode] = useState(defaultMode);
  const active = modes.find((mode) => mode.id === activeMode) ?? modes[0] ?? null;

  if (!active) return null;

  return (
    <div
      data-macro-extension-composer-style={composer.style ?? 'inline'}
      className="border-t border-border bg-card/95 p-3 shadow-lg"
    >
      <div className="mb-2 flex items-center gap-1 overflow-x-auto">
        {modes.map((mode) => (
          <button
            key={mode.id}
            type="button"
            className={cn(
              'rounded-md px-2 py-1 text-xs font-medium transition-colors',
              active.id === mode.id
                ? 'bg-primary/10 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
            onClick={() => setActiveMode(mode.id)}
          >
            {mode.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2">
        <Icon name="sparkles" size={16} className="shrink-0 text-primary" />
        <input
          className="h-9 min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          placeholder={composer.placeholder ?? 'Describe a change'}
        />
        <button
          type="button"
          className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground"
        >
          {active.label}
        </button>
      </div>
    </div>
  );
};
