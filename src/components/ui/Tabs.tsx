import React, { createContext, useContext, useId } from 'react';
import { cn } from '../../utils/cn';

interface TabsContextValue {
  tabsId: string;
  activeTab: string;
  setActiveTab: (value: string) => void;
}

const TabsContext = createContext<TabsContextValue | undefined>(undefined);

const toTabIdPart = (value: string): string =>
  encodeURIComponent(value).replace(/%/g, '-');

const getTabId = (tabsId: string, value: string): string =>
  `${tabsId}-tab-${toTabIdPart(value)}`;

const getPanelId = (tabsId: string, value: string): string =>
  `${tabsId}-panel-${toTabIdPart(value)}`;

interface TabsProps extends React.HTMLAttributes<HTMLDivElement> {
  defaultValue: string;
  value?: string;
  onValueChange?: (value: string) => void;
  children: React.ReactNode;
}

export const Tabs: React.FC<TabsProps> = ({
  defaultValue,
  value,
  onValueChange,
  children,
  className,
  ...props
}) => {
  const [internalValue, setInternalValue] = React.useState(defaultValue);
  const generatedId = useId();
  const tabsId = `tabs-${toTabIdPart(generatedId)}`;
  const activeTab = value !== undefined ? value : internalValue;

  React.useEffect(() => {
    if (value === undefined) {
      setInternalValue(defaultValue);
    }
  }, [defaultValue, value]);

  const setActiveTab = (nextValue: string) => {
    onValueChange?.(nextValue);
    if (value === undefined) {
      setInternalValue(nextValue);
    }
  };

  return (
    <TabsContext.Provider value={{ tabsId, activeTab, setActiveTab }}>
      <div className={className} {...props}>
        {children}
      </div>
    </TabsContext.Provider>
  );
};

interface TabsListProps extends React.HTMLAttributes<HTMLDivElement> {
  children: React.ReactNode;
}

export const TabsList: React.FC<TabsListProps> = ({
  children,
  className,
  ...props
}) => {
  return (
    <div
      role="tablist"
      className={cn(
        'inline-flex items-center gap-1 p-1 bg-elevated rounded-lg border border-border',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};

interface TabsTriggerProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'type' | 'onClick'> {
  value: string;
  children: React.ReactNode;
  onClick?: React.MouseEventHandler<HTMLButtonElement>;
}

export const TabsTrigger: React.FC<TabsTriggerProps> = ({
  value,
  children,
  className,
  onClick,
  onKeyDown,
  ...props
}) => {
  const context = useContext(TabsContext);
  if (!context) throw new Error('TabsTrigger must be used within Tabs');
  const { tabsId, activeTab, setActiveTab } = context;
  const isActive = activeTab === value;
  const tabId = getTabId(tabsId, value);
  const panelId = getPanelId(tabsId, value);

  const handleKeyDown: React.KeyboardEventHandler<HTMLButtonElement> = (event) => {
    onKeyDown?.(event);
    if (event.defaultPrevented) return;

    const direction =
      event.key === 'ArrowRight' || event.key === 'ArrowDown'
        ? 1
        : event.key === 'ArrowLeft' || event.key === 'ArrowUp'
          ? -1
          : 0;
    const tablist = event.currentTarget.closest('[role="tablist"]');
    const tabs = tablist
      ? Array.from(tablist.querySelectorAll<HTMLButtonElement>('[role="tab"]'))
      : [];

    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const nextTab = event.key === 'Home' ? tabs[0] : tabs[tabs.length - 1];
      nextTab?.focus();
      nextTab?.click();
      return;
    }

    if (direction === 0 || tabs.length === 0) return;
    event.preventDefault();
    const currentIndex = tabs.indexOf(event.currentTarget);
    const nextIndex = (currentIndex + direction + tabs.length) % tabs.length;
    tabs[nextIndex]?.focus();
    tabs[nextIndex]?.click();
  };

  return (
    <button
      type="button"
      role="tab"
      id={tabId}
      aria-selected={isActive}
      aria-controls={panelId}
      tabIndex={isActive ? 0 : -1}
      onClick={(event) => {
        setActiveTab(value);
        onClick?.(event);
      }}
      onKeyDown={handleKeyDown}
      className={cn(
        'px-4 py-2 text-sm font-medium rounded-md transition-all duration-200',
        'hover:text-text-primary',
        isActive
          ? 'bg-primary/10 text-primary shadow-sm'
          : 'text-text-secondary',
        className
      )}
      {...props}
    >
      {children}
    </button>
  );
};

interface TabsContentProps extends React.HTMLAttributes<HTMLDivElement> {
  value: string;
  children: React.ReactNode;
  fullHeight?: boolean;
}

export const TabsContent: React.FC<TabsContentProps> = ({
  value,
  children,
  className,
  fullHeight = false,
  ...props
}) => {
  const context = useContext(TabsContext);
  if (!context) throw new Error('TabsContent must be used within Tabs');
  const { tabsId, activeTab } = context;

  if (activeTab !== value) return null;

  return (
    <div
      id={getPanelId(tabsId, value)}
      role="tabpanel"
      aria-labelledby={getTabId(tabsId, value)}
      tabIndex={0}
      className={cn(
        'animate-fade-in',
        fullHeight ? 'h-full min-h-0 flex flex-col' : 'mt-4',
        className
      )}
      {...props}
    >
      {children}
    </div>
  );
};
