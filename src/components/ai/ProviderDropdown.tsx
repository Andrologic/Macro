import React, { useState, useRef, useEffect } from 'react';
import { useAIStore } from '../../stores/useAIStore';
import { AIProviderStatus } from '../../types';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { Badge } from '../ui/Badge';

const statusColors: Record<AIProviderStatus, 'success' | 'warning' | 'error'> = {
  online: 'success',
  degraded: 'warning',
  offline: 'error',
};

export const ProviderDropdown: React.FC = () => {
  const { providers, selectedProviderId, selectProvider } = useAIStore();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const selectedProvider = providers.find((p) => p.id === selectedProviderId);

  const handleSelect = (providerId: string) => {
    selectProvider(providerId);
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
        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border hover:border-primary/50 transition-colors w-[120px]"
      >
        <span className="text-xs text-muted-foreground truncate">
          {selectedProvider?.name ?? 'Provider'}
        </span>
        <Icon name="chevron-down" size={10} className="text-muted-foreground" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className={cn(
            'absolute z-50 w-full bottom-full mb-1 bg-card border border-border',
            'rounded-lg shadow-xl max-h-60 overflow-y-auto',
            'flex flex-col'
          )}
        >
          {providers.map((provider) => (
            <button
              key={provider.id}
              onClick={() => handleSelect(provider.id)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm',
                'transition-colors',
                selectedProviderId === provider.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <span>{provider.name}</span>
            </button>
          ))}

          {providers.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              No providers available
            </div>
          )}
        </div>
      )}
    </div>
  );
};
