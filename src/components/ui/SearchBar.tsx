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
}

export const SearchBar: React.FC<SearchBarProps> = ({
  value,
  onChange,
  placeholder = i18n.t('common.searchPlaceholder', 'Search...'),
  className,
  showClear = true,
  inputId,
  inputAriaLabel,
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
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={inputAriaLabel ?? placeholder}
        className="flex-1 min-w-0 bg-transparent border-none outline-none text-sm text-foreground placeholder:text-muted-foreground"
      />
      {showClear && value && (
        <button
          type="button"
          onClick={handleClear}
          className="flex-shrink-0 p-0.5 hover:bg-accent rounded transition-colors mx-1"
          aria-label={i18n.t('common.clearSearch', 'Clear search')}
        >
          <Icon name="x" size={14} className="text-muted-foreground hover:text-foreground" />
        </button>
      )}
    </div>
  );
};
