import React from 'react';
import { Icon } from './Icon';
import i18n from '../../i18n';
import { cn } from '../../utils/cn';

interface SearchBarProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'onChange'> {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  showClear?: boolean;
  inputId?: string;
  inputAriaLabel?: string;
  inputAutoFocus?: boolean;
}

export const SearchBar: React.FC<SearchBarProps> = ({
  value,
  onChange,
  placeholder = i18n.t('common.searchPlaceholder', 'Search...'),
  className,
  showClear = true,
  inputId,
  inputAriaLabel,
  inputAutoFocus = false,
  'aria-label': containerAriaLabel,
  ...props
}) => {
  const handleClear = () => {
    onChange('');
  };

  return (
    <div
      className={cn(
        'relative flex items-center w-full bg-muted/50 border border-border rounded-lg px-2 py-2 overflow-hidden',
        'focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/50',
        'transition-all duration-200',
        className
      )}
      {...props}
      aria-label={containerAriaLabel}
    >
      <Icon name="search" size={16} className="text-muted-foreground flex-shrink-0 mx-1" />
      <input
        id={inputId}
        autoFocus={inputAutoFocus}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={inputAriaLabel ?? placeholder}
        className="min-w-0 flex-1 border-none bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:[box-shadow:none]"
      />
      {showClear && value && (
        <button
          type="button"
          onClick={handleClear}
          className="mx-1 flex-shrink-0 rounded p-0.5 transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:[box-shadow:none]"
          aria-label={i18n.t('common.clearSearch', 'Clear search')}
        >
          <Icon name="x" size={14} className="text-muted-foreground hover:text-foreground" />
        </button>
      )}
    </div>
  );
};
