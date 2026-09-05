import React, { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useProviderStore } from '../../stores/useProviderStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { getReasoningEffortLabel } from './reasoningLabels';
import { useDropdownListNavigation } from './useDropdownListNavigation';

export const ReasoningDropdown: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedProviderId,
    selectedModelId,
    selectedReasoningEffort,
    getAvailableReasoningEfforts,
    selectReasoningEffort,
  } = useProviderStore();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const availableEfforts = getAvailableReasoningEfforts(selectedProviderId, selectedModelId);
  const hasChoices = availableEfforts.length > 0;
  const currentLabel = selectedReasoningEffort
    ? getReasoningEffortLabel(t, selectedReasoningEffort)
    : availableEfforts[0]
      ? getReasoningEffortLabel(t, availableEfforts[0])
      : t('models.reasoningEffort', 'Reasoning');
  const {
    activeIndex,
    close,
    handleListKeyDown,
    handleTriggerKeyDown,
    open,
    optionRefs,
    select,
    setActiveIndex,
    triggerRef,
  } = useDropdownListNavigation({
    isOpen,
    setIsOpen,
    itemCount: availableEfforts.length,
    selectedIndex: selectedReasoningEffort
      ? availableEfforts.indexOf(selectedReasoningEffort)
      : 0,
    onSelect: (index) => {
      const effort = availableEfforts[index];
      if (effort) selectReasoningEffort(effort);
    },
  });

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
    <div ref={containerRef} className="relative" data-tour-id="reasoning-dropdown">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => isOpen ? close() : open()}
        onKeyDown={handleTriggerKeyDown}
        aria-label={t('chat.reasoningSelector', 'Choose reasoning level')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border hover:border-primary/50 transition-colors min-w-[118px]"
      >
        <span className="text-xs text-muted-foreground truncate">{currentLabel}</span>
        <Icon name="chevron-down" size={10} className="text-muted-foreground shrink-0" />
      </button>

      {isOpen && (
        <div
          id={listboxId}
          role="listbox"
          aria-label={t('chat.reasoningSelector', 'Choose reasoning level')}
          onKeyDown={handleListKeyDown}
          className={cn(
            'absolute z-50 min-w-[180px] bottom-full mb-1 bg-card border border-border',
            'rounded-lg shadow-xl max-h-80 overflow-y-auto flex flex-col'
          )}
        >
          {availableEfforts.map((effort, index) => (
            <button
              key={effort}
              ref={(element) => { optionRefs.current[index] = element; }}
              type="button"
              role="option"
              aria-selected={selectedReasoningEffort === effort}
              tabIndex={index === activeIndex ? 0 : -1}
              onFocus={() => setActiveIndex(index)}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => select(index)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm transition-colors',
                selectedReasoningEffort === effort
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {getReasoningEffortLabel(t, effort)}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};
