import React, {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { SearchBar } from '../../ui/SearchBar';

type SettingsSearchContextValue = {
  query: string;
  setQuery: (query: string) => void;
  matches: (...values: Array<string | false | null | undefined>) => boolean;
};

const SettingsSearchContext = createContext<SettingsSearchContextValue | null>(null);

const normalizeSearchText = (value: string): string =>
  value
    .normalize('NFKC')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase()
    .trim();

export const matchesSettingsSearch = (
  query: string,
  ...values: Array<string | false | null | undefined>
): boolean => {
  const tokens = normalizeSearchText(query).split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return true;
  const haystack = normalizeSearchText(values.filter(Boolean).join(' '));
  return tokens.every((token) => haystack.includes(token));
};

export const SettingsSearchProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [query, setQuery] = useState('');

  const matches = useCallback(
    (...values: Array<string | false | null | undefined>): boolean =>
      matchesSettingsSearch(query, ...values),
    [query]
  );

  const value = useMemo(
    () => ({ query, setQuery, matches }),
    [matches, query]
  );

  return <SettingsSearchContext.Provider value={value}>{children}</SettingsSearchContext.Provider>;
};

export const useSettingsSearch = (): SettingsSearchContextValue => {
  const context = useContext(SettingsSearchContext);
  if (!context) {
    throw new Error('useSettingsSearch must be used inside SettingsSearchProvider');
  }
  return context;
};

type SettingsSearchBarProps = {
  placeholder: string;
  className?: string;
};

export const SettingsSearchBar: React.FC<SettingsSearchBarProps> = ({
  placeholder,
  className,
}) => {
  const { query, setQuery } = useSettingsSearch();

  return (
    <SearchBar
      value={query}
      onChange={setQuery}
      placeholder={placeholder}
      inputAriaLabel={placeholder}
      className={className}
    />
  );
};

type SettingsCollectionHeaderProps = {
  title: string;
  description?: string;
  searchPlaceholder?: string;
  action?: React.ReactNode;
  className?: string;
};

export const SettingsCollectionHeader: React.FC<SettingsCollectionHeaderProps> = ({
  title,
  description,
  searchPlaceholder,
  action,
  className,
}) => (
  <div
    className={[
      'flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between',
      className,
    ].filter(Boolean).join(' ')}
  >
    <div className="min-w-0">
      <h4 className="text-sm font-semibold text-foreground">{title}</h4>
      {description && (
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      )}
    </div>
    {(searchPlaceholder || action) && (
      <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
        {searchPlaceholder && (
          <SettingsSearchBar
            placeholder={searchPlaceholder}
            className="h-9 min-w-0 flex-1 bg-background sm:w-72 sm:flex-none"
          />
        )}
        {action}
      </div>
    )}
  </div>
);

export const SettingsSearchEmpty: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="rounded-xl border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
      {t('settings.searchNoResults', 'No matching settings')}
    </div>
  );
};
