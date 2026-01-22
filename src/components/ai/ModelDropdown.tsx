import React, { useState, useRef, useEffect } from 'react';
import { useAIStore } from '../../stores/useAIStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';

export const ModelDropdown: React.FC = () => {
  const { models, selectedModelId, selectModel, selectedProviderId } = useAIStore();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const validModels = models.filter((model) => model.id && model.id.trim() !== '');
  const selectedModel = validModels.find((m) => m.id === selectedModelId);

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
        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-zinc-800/80 border border-zinc-700 hover:border-zinc-600 transition-colors"
      >
        <span className="text-xs text-zinc-300 truncate max-w-[120px]">
          {selectedModel?.name ?? 'Model'}
        </span>
        <Icon name="chevron-down" size={10} className="text-zinc-500" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className={cn(
            'absolute z-50 w-[320px] bottom-full mb-1 bg-zinc-800 border border-zinc-700',
            'rounded-lg shadow-xl max-h-96 overflow-y-auto',
            'flex flex-col'
          )}
        >
          {validModels.map((model) => (
            <button
              key={model.id}
              onClick={() => handleSelect(model.id)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm',
                'flex flex-col gap-1 transition-colors',
                selectedModelId === model.id
                  ? 'bg-indigo-500 text-white'
                  : 'text-zinc-300 hover:bg-zinc-700'
              )}
            >
              <span className="font-medium">{model.name}</span>
              {(model as any).description && (
                <span className="text-xs opacity-70 ml-6">
                  {(model as any).description}
                </span>
              )}
            </button>
          ))}

          {validModels.length === 0 && (
            <div className="px-3 py-2 text-sm text-zinc-500">
              {selectedProviderId ? 'No models available for this provider' : 'Select a provider first'}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
