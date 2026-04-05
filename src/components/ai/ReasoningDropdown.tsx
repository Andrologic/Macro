import React, { useEffect, useRef, useState } from 'react';
import { useProviderStore } from '../../stores/useProviderStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { getReasoningLabel } from '../../services/reasoningCatalog';

export const ReasoningDropdown: React.FC = () => {
  const {
    selectedProviderId,
    selectedModelId,
    selectedReasoningEffort,
    getAvailableReasoningEfforts,
    selectReasoningEffort,
  } = useProviderStore();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const availableEfforts = getAvailableReasoningEfforts(selectedProviderId, selectedModelId);
  const hasChoices = availableEfforts.length > 0;
  const currentLabel = selectedReasoningEffort
    ? getReasoningLabel(selectedReasoningEffort)
    : availableEfforts[0]
      ? getReasoningLabel(availableEfforts[0])
      : 'Reasoning';

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen]);

  if (!hasChoices) {
    return null;
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setIsOpen((value) => !value)}
        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border hover:border-primary/50 transition-colors min-w-[118px]"
      >
        <span className="text-xs text-muted-foreground truncate">{currentLabel}</span>
        <Icon name="chevron-down" size={10} className="text-muted-foreground shrink-0" />
      </button>

      {isOpen && (
        <div
          className={cn(
            'absolute z-50 min-w-[180px] bottom-full mb-1 bg-card border border-border',
            'rounded-lg shadow-xl max-h-80 overflow-y-auto flex flex-col'
          )}
        >
          {availableEfforts.map((effort) => (
            <button
              key={effort}
              type="button"
              onClick={() => {
                selectReasoningEffort(effort);
                setIsOpen(false);
              }}
              className={cn(
                'w-full px-3 py-2 text-left text-sm transition-colors',
                selectedReasoningEffort === effort
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {getReasoningLabel(effort)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
