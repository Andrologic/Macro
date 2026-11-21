import React, { useId, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { matchesLocalSearchQuery } from '../../services/localModeSearch';
import { lookupModelCatalogMetadata } from '../../services/modelContextCatalog';
import { providerHasCredentials, useProviderStore } from '../../stores/useProviderStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';
import { useDropdownListNavigation } from './useDropdownListNavigation';

export const ModelDropdown: React.FC<{
  isOpen?: boolean;
  onOpenChange?: (isOpen: boolean) => void;
}> = ({ isOpen: controlledIsOpen, onOpenChange }) => {
  const { t } = useTranslation();
  const {
    selectedProviderId,
    selectedModelId,
    modelsByProvider,
    providerConfigs,
    selectProviderModel,
    isLoadingModels,
  } = useProviderStore();

  const [localIsOpen, setLocalIsOpen] = useState(false);
  const isOpen = controlledIsOpen ?? localIsOpen;
  const setIsOpen = onOpenChange ?? setLocalIsOpen;
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const enabledProviders = providerConfigs.filter(providerHasCredentials);
  const selectedProvider = enabledProviders.find((provider) => provider.id === selectedProviderId);
  const selectedModel = (modelsByProvider[selectedProviderId ?? ''] ?? [])
    .find((model) => model.id === selectedModelId && model.isEnabled !== false);
  const choices = enabledProviders.flatMap((provider) =>
    (modelsByProvider[provider.id] ?? [])
      .filter((model) => model.isEnabled !== false)
      .map((model) => ({ provider, model }))
  );
  const filteredModels = choices.filter(({ provider, model }) => {
    const metadata = lookupModelCatalogMetadata({
      providerId: provider.id,
      providerType: provider.providerType,
      baseUrl: provider.baseUrl,
      modelId: model.id,
    });
    return matchesLocalSearchQuery(query, [
      provider.name, provider.id, model.name, model.id, model.description, metadata?.name, metadata?.family,
    ]);
  });

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
    itemCount: filteredModels.length,
    selectedIndex: filteredModels.findIndex(({ provider, model }) =>
      provider.id === selectedProviderId && model.id === selectedModelId),
    searchInputRef,
    onSelect: (index) => {
      const choice = filteredModels[index];
      if (choice) selectProviderModel(choice.provider.id, choice.model.id);
    },
  });

  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);

  useEffect(() => {
    if (isOpen) optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex, isOpen, optionRefs, query]);

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
  }, [isOpen, setIsOpen]);

  return (
    <div ref={containerRef} className="relative" data-tour-id="model-dropdown"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) close(); }}>
      {/* Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => isOpen ? close() : open()}
        onKeyDown={handleTriggerKeyDown}
        aria-label={t('chat.modelSelector', 'Choose AI model')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        className={cn(
          'flex max-w-full items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border transition-colors hover:border-primary/50'
        )}
      >
        <span className="text-xs text-foreground truncate max-w-[240px]"
          title={selectedProvider && selectedModel ? `${selectedProvider.name} · ${selectedModel.name || selectedModel.id}` : undefined}>
          {selectedProvider && selectedModel
            ? `${selectedProvider.name} · ${selectedModel.name || selectedModel.id}`
            : t('chat.selectModel', 'Select a model')}
        </span>
        {isLoadingModels && <SpinnerIcon size={12} className="text-muted-foreground shrink-0"
          label={t('chat.loadingModels', 'Loading models')} />}
        <Icon name="chevron-down" size={10} className="text-muted-foreground" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) handleListKeyDown(event); }}
          className="absolute z-50 w-[380px] max-w-[calc(100vw-2rem)] bottom-full mb-1 bg-card border border-border rounded-lg shadow-xl flex flex-col"
        >
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
            <Icon name="search" size={14} className="text-muted-foreground shrink-0" />
            <input
              ref={searchInputRef}
              role="combobox"
              aria-label={t('chat.modelSearchLabel', 'Search models')}
              aria-autocomplete="list"
              aria-expanded={isOpen}
              aria-controls={listboxId}
              aria-activedescendant={filteredModels[activeIndex] ? `${listboxId}-${activeIndex}` : undefined}
              placeholder={t('chat.modelSearchPlaceholder', 'Search models…')}
              value={query}
              onChange={(event) => { setQuery(event.target.value); setActiveIndex(0); }}
              onKeyDown={(event) => {
                if (!event.nativeEvent.isComposing && ['ArrowDown', 'ArrowUp', 'Enter', 'Escape'].includes(event.key)) {
                  handleListKeyDown(event);
                }
              }}
              className="w-full min-w-0 bg-transparent px-1 py-1 text-xs outline-none focus:ring-1 focus:ring-primary rounded"
            />
            {query && (
              <button type="button" aria-label={t('chat.modelSearchClear', 'Clear model search')}
                onClick={() => { setQuery(''); setActiveIndex(0); searchInputRef.current?.focus(); }}
                className="p-1 text-muted-foreground hover:text-foreground">
                <Icon name="x" size={12} />
              </button>
            )}
          </div>
          <div aria-hidden="true" className="flex justify-between px-3 py-2 text-[11px] text-muted-foreground">
            <span>{t('chat.modelColumn', 'Model')}</span>
            <span>{t('chat.providerColumn', 'Provider')}</span>
          </div>
          <div id={listboxId} role="listbox" aria-label={t('chat.modelSelector', 'Choose AI model')}
            aria-busy={isLoadingModels} onKeyDown={handleListKeyDown}
            className="max-h-[min(320px,45vh)] overflow-y-auto px-1">
            {filteredModels.map(({ provider, model }, index) => {
              const isSelected = selectedProviderId === provider.id && selectedModelId === model.id;
              return (
                <button
                  key={JSON.stringify([provider.id, model.id])}
                  id={`${listboxId}-${index}`}
                  ref={(element) => { optionRefs.current[index] = element; }}
                  type="button" role="option" aria-selected={isSelected} tabIndex={-1}
                  title={[model.name || model.id, provider.name, model.id, model.description].filter(Boolean).join(' · ')}
                  onFocus={() => setActiveIndex(index)} onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => select(index)}
                  className={cn(
                    'w-full px-2 py-2 text-left text-sm flex items-center gap-2 rounded-sm transition-colors',
                    isSelected ? 'bg-primary/15 text-foreground' : 'text-foreground hover:bg-accent',
                    !isSelected && index === activeIndex && 'bg-accent'
                  )}
                >
                  <span className="w-4 shrink-0">{isSelected && <Icon name="check" size={14} />}</span>
                  <span className="min-w-0 flex-1 truncate">{model.name || model.id}</span>
                  <span className="max-w-[128px] shrink-0 truncate text-xs text-muted-foreground">{provider.name}</span>
                </button>
              );
            })}

            {filteredModels.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {query.trim()
                  ? t('chat.modelSearchEmpty', 'No matching models.')
                  : enabledProviders.length > 0
                  ? t('chat.noEnabledModels', 'No enabled models. Enable models in Settings.')
                  : t('chat.noProvidersConfigured', 'No providers configured')}
              </div>
            )}
          </div>
          <div className="px-3 py-2 mt-1 border-t border-border text-[10px] text-muted-foreground">
            {t('chat.modelNavigationHint', '↑↓ navigate · Enter choose · Esc close')}
          </div>
        </div>
      )}
    </div>
  );
};
