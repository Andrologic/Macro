import React, { useState, useRef, useEffect } from 'react';
import { useProviderStore } from '../../stores/useProviderStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

export const ModelDropdown: React.FC = () => {
  const {
    selectedProviderId,
    selectedModelId,
    modelsByProvider,
    selectModel,
    isLoadingModels,
  } = useProviderStore();

  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const models = selectedProviderId ? (modelsByProvider[selectedProviderId] || []) : [];
  const enabledModels = models.filter((model) => model.isEnabled !== false);
  const selectedModel = enabledModels.find((m) => m.id === selectedModelId);

  const handleSelect = (modelId: string) => {
    selectModel(modelId);
    setIsOpen(false);
  };

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

  return (
    <div ref={containerRef} className="relative">
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        disabled={!selectedProviderId}
        className={cn(
          'flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border transition-colors',
          selectedProviderId
            ? 'hover:border-primary/50'
            : 'opacity-50 cursor-not-allowed'
        )}
      >
        {isLoadingModels ? (
          <Icon name="loader" size={12} className="animate-spin text-muted-foreground" />
        ) : (
          <span className="text-xs text-muted-foreground truncate max-w-[140px]">
            {selectedModel?.name ?? 'Select Model'}
          </span>
        )}
        <Icon name="chevron-down" size={10} className="text-muted-foreground" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className={cn(
            'absolute z-50 w-[320px] bottom-full mb-1 bg-card border border-border',
            'rounded-lg shadow-xl max-h-96 overflow-y-auto',
            'flex flex-col'
          )}
        >
          {enabledModels.map((model) => (
            <button
              key={model.id}
              onClick={() => handleSelect(model.id)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm',
                'flex flex-col gap-1 transition-colors',
                selectedModelId === model.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <span className="font-medium">{model.name || model.id}</span>
            </button>
          ))}

          {enabledModels.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {selectedProviderId
                ? 'No enabled models. Enable models in Settings.'
                : 'Select a provider first'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
