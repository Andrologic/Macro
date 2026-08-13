import React, { useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { providerHasCredentials, useProviderStore } from '../../stores/useProviderStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { isMacroAiProvider } from '../../config/macroAi';
import { AndrologicProviderIcon } from './AndrologicProviderIcon';

export const ProviderDropdown: React.FC = () => {
  const { t } = useTranslation();
  const { providerConfigs, selectedProviderId, selectProvider } = useProviderStore();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  const enabledProviders = providerConfigs.filter((provider) => providerHasCredentials(provider));
  const selectedProvider = providerConfigs.find((p) => p.id === selectedProviderId);

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
    <div ref={containerRef} className="relative" data-tour-id="provider-dropdown">
      {/* Trigger Button */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border hover:border-primary/50 transition-colors w-[140px]"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isMacroAiProvider(selectedProvider?.id) ? (
            <AndrologicProviderIcon className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <Icon
              name={selectedProvider?.isLocal ? 'hard-drive' : 'cloud'}
              size={12}
              className="text-muted-foreground shrink-0"
            />
          )}
          <span className="text-xs text-muted-foreground truncate">
            {selectedProvider?.name ?? t('chat.selectProvider', 'Select a provider')}
          </span>
        </div>
        <Icon name="chevron-down" size={10} className="text-muted-foreground shrink-0" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          className={cn(
            'absolute z-50 w-48 bottom-full mb-1 bg-card border border-border',
            'rounded-lg shadow-xl max-h-60 overflow-y-auto',
            'flex flex-col'
          )}
        >
          {enabledProviders.map((provider) => (
            <button
              key={provider.id}
              onClick={() => handleSelect(provider.id)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm flex items-center gap-2',
                'transition-colors',
                selectedProviderId === provider.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              {isMacroAiProvider(provider.id) ? (
                <AndrologicProviderIcon className="h-4 w-4" />
              ) : (
                <Icon name={provider.isLocal ? 'hard-drive' : 'cloud'} size={14} />
              )}
              <span className="flex min-w-0 flex-col">
                <span>{provider.name}</span>
                {isMacroAiProvider(provider.id) && (
                  <span className="text-[10px] opacity-75">
                    {t('providers.macroAi.dropdownNotice', 'AI included with the beta')}
                  </span>
                )}
              </span>
            </button>
          ))}

          {enabledProviders.length === 0 && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {t('chat.noProvidersConfigured', 'No providers configured')}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
