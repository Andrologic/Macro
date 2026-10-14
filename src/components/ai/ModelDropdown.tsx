import React, { useId, useState, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { matchesLocalSearchQuery } from '../../services/localModeSearch';
import { lookupModelCatalogMetadata } from '../../services/modelContextCatalog';
import { useProviderStore } from '../../stores/useProviderStore';
import { cn } from '../../utils/cn';
import { Icon } from '../ui/Icon';
import { SpinnerIcon } from '../ui/SpinnerIcon';
import { useDropdownListNavigation } from './useDropdownListNavigation';
import { ModelCatalogSummary } from './ModelCatalogSummary';

export const ModelDropdown: React.FC = () => {
  const { t } = useTranslation();
  const {
    selectedProviderId,
    selectedModelId,
    modelsByProvider,
    providerConfigs,
    selectModel,
    isLoadingModels,
  } = useProviderStore();

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();

  const models = selectedProviderId ? (modelsByProvider[selectedProviderId] || []) : [];
  const enabledModels = models.filter((model) => model.isEnabled !== false);
  const selectedModel = enabledModels.find((m) => m.id === selectedModelId);
  const selectedProvider = providerConfigs.find((provider) => provider.id === selectedProviderId);

  const filteredModels = enabledModels.filter((model) => {
    const metadata = lookupModelCatalogMetadata({
      providerId: selectedProviderId,
      providerType: selectedProvider?.providerType,
      baseUrl: selectedProvider?.baseUrl,
      modelId: model.id,
    });
    return matchesLocalSearchQuery(query, [model.name, model.id, model.description, metadata?.name, metadata?.family]);
  });

  const handleSelect = (modelId: string) => {
    selectModel(modelId);
  };
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
    selectedIndex: filteredModels.findIndex((model) => model.id === selectedModelId),
    searchInputRef,
    onSelect: (index) => {
      const model = filteredModels[index];
      if (model) handleSelect(model.id);
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
  }, [isOpen]);

  return (
    <div ref={containerRef} className="relative" data-tour-id="model-dropdown">
      {/* Trigger Button */}
      <button
        ref={triggerRef}
        type="button"
        onClick={() => isOpen ? close() : open()}
        onKeyDown={handleTriggerKeyDown}
        disabled={!selectedProviderId}
        aria-label={t('chat.modelSelector', 'Choose AI model')}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={isOpen ? listboxId : undefined}
        className={cn(
          'flex items-center justify-between gap-2 px-3 py-1.5 rounded-lg bg-muted/80 border border-border transition-colors',
          selectedProviderId
            ? 'hover:border-primary/50'
            : 'opacity-50 cursor-not-allowed'
        )}
      >
        {isLoadingModels ? (
          <SpinnerIcon
            size={12}
            className="text-muted-foreground"
            label={t('chat.loadingModels', 'Loading models')}
          />
        ) : (
          <span className="text-xs text-muted-foreground truncate max-w-[140px]">
            {selectedModel?.name ?? t('chat.selectModel', 'Select a model')}
          </span>
        )}
        <Icon name="chevron-down" size={10} className="text-muted-foreground" />
      </button>

      {/* Dropdown */}
      {isOpen && (
        <div
          onKeyDown={(event) => { if (event.key === 'Escape' && !event.defaultPrevented) handleListKeyDown(event); }}
          className="absolute z-50 w-[320px] bottom-full mb-1 bg-card border border-border rounded-lg shadow-xl flex flex-col"
        >
          <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border">
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
          <div id={listboxId} role="listbox" aria-label={t('chat.modelSelector', 'Choose AI model')}
            onKeyDown={handleListKeyDown} className="max-h-80 overflow-y-auto">
            {filteredModels.map((model, index) => (
              <button
                key={model.id}
                id={`${listboxId}-${index}`}
                ref={(element) => { optionRefs.current[index] = element; }}
                type="button"
                role="option"
                aria-selected={selectedModelId === model.id}
                tabIndex={-1}
                onFocus={() => setActiveIndex(index)}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(index)}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm',
                  'flex flex-col gap-1 transition-colors',
                  selectedModelId === model.id
                    ? 'bg-primary text-primary-foreground'
                    : cn('text-muted-foreground hover:bg-accent', index === activeIndex && 'bg-accent')
                )}
              >
                <span className="font-medium">{model.name || model.id}</span>
                {model.description && (
                  <span className="text-xs leading-snug opacity-75">
                    {model.description}
                  </span>
                )}
                {selectedProvider && <ModelCatalogSummary model={model} provider={selectedProvider} />}
              </button>
            ))}

            {filteredModels.length === 0 && (
              <div className="px-3 py-2 text-sm text-muted-foreground">
                {query.trim()
                  ? t('chat.modelSearchEmpty', 'No matching models.')
                  : selectedProviderId
                  ? t('chat.noEnabledModels', 'No enabled models. Enable models in Settings.')
                  : t('chat.selectProviderFirst', 'Select a provider first')}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
