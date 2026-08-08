import React, { useState, useRef, useEffect, useCallback, useLayoutEffect } from 'react';
import { createPortal } from 'react-dom';
import i18n from '../../i18n';
import { cn } from '../../utils/cn';
import { Icon } from './Icon';

interface GroupComboboxProps {
  projectGroups: Array<{ id: string; name: string }>;
  selectedGroupId: string | null;
  onSelect: (groupId: string | null) => void;
  onCreateGroup?: (name: string) => void;
  className?: string;
  placeholder?: string;
}

interface DropdownPosition {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
  placement: 'top' | 'bottom';
  boundaryTop: number;
}

export const GroupCombobox: React.FC<GroupComboboxProps> = ({
  projectGroups,
  selectedGroupId,
  onSelect,
  onCreateGroup,
  className,
  placeholder = i18n.t('project.selectGroupPlaceholder', 'Select a group...'),
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [dropdownPosition, setDropdownPosition] = useState<DropdownPosition | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedGroup = projectGroups.find((g) => g.id === selectedGroupId);
  const displayValue = isCreating ? query : (selectedGroup?.name || '');

  const filteredGroups = projectGroups.filter((group) =>
    group.name.toLowerCase().includes(query.toLowerCase())
  );

  const hasMatch = filteredGroups.some((g) => g.name.toLowerCase() === query.toLowerCase());
  const showCreateOption = query.length > 0 && !hasMatch && onCreateGroup;

  const updateDropdownPosition = useCallback(() => {
    const container = containerRef.current;
    if (!container || typeof window === 'undefined') return;

    const triggerRect = container.getBoundingClientRect();
    const gap = 4;
    const viewportMargin = 8;
    const preferredHeight = 240;

    let boundaryTop = viewportMargin;
    let boundaryBottom = window.innerHeight - viewportMargin;
    let boundaryParent = container.parentElement;

    while (boundaryParent && boundaryParent !== document.body) {
      const style = window.getComputedStyle(boundaryParent);
      const clipsOverflow = /(auto|scroll|hidden|clip)/.test(`${style.overflow} ${style.overflowY}`);

      if (clipsOverflow) {
        const boundaryRect = boundaryParent.getBoundingClientRect();
        boundaryTop = Math.max(viewportMargin, boundaryRect.top);
        boundaryBottom = Math.min(window.innerHeight - viewportMargin, boundaryRect.bottom);
        break;
      }

      boundaryParent = boundaryParent.parentElement;
    }

    const spaceBelow = boundaryBottom - triggerRect.bottom;
    const spaceAbove = triggerRect.top - boundaryTop;
    const shouldOpenUp = spaceBelow < 180 && spaceAbove > spaceBelow;
    const availableHeight = shouldOpenUp ? spaceAbove : spaceBelow;
    const maxHeight = Math.max(120, Math.min(preferredHeight, availableHeight - gap));

    setDropdownPosition({
      top: shouldOpenUp
        ? Math.max(boundaryTop, triggerRect.top - maxHeight - gap)
        : triggerRect.bottom + gap,
      left: triggerRect.left,
      width: triggerRect.width,
      maxHeight,
      placement: shouldOpenUp ? 'top' : 'bottom',
      boundaryTop,
    });
  }, []);

  const handleSelect = (groupId: string | null) => {
    onSelect(groupId);
    setIsOpen(false);
    setIsCreating(false);
    setQuery('');
  };

  const handleCreateNew = () => {
    if (onCreateGroup && query.trim()) {
      onCreateGroup(query.trim());
      setIsCreating(false);
      setQuery('');
      setIsOpen(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setQuery(value);

    if (!isCreating && value) {
      setIsCreating(true);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      setIsOpen(false);
      setIsCreating(false);
      setQuery('');
    } else if (e.key === 'Enter' && showCreateOption) {
      e.preventDefault();
      handleCreateNew();
    }
  };

  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      const clickedTrigger = containerRef.current?.contains(target) ?? false;
      const clickedDropdown = dropdownRef.current?.contains(target) ?? false;

      if (!clickedTrigger && !clickedDropdown) {
        setIsOpen(false);
        if (!selectedGroupId) {
          setQuery('');
        }
      }
    };

    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [isOpen, selectedGroupId]);

  useEffect(() => {
    if (!isOpen) {
      setDropdownPosition(null);
      return;
    }

    updateDropdownPosition();
    window.addEventListener('resize', updateDropdownPosition);
    window.addEventListener('scroll', updateDropdownPosition, true);

    return () => {
      window.removeEventListener('resize', updateDropdownPosition);
      window.removeEventListener('scroll', updateDropdownPosition, true);
    };
  }, [isOpen, updateDropdownPosition]);

  useLayoutEffect(() => {
    if (!isOpen || dropdownPosition?.placement !== 'top') return;

    const container = containerRef.current;
    const dropdownElement = dropdownRef.current;
    if (!container || !dropdownElement) return;

    const triggerRect = container.getBoundingClientRect();
    const dropdownRect = dropdownElement.getBoundingClientRect();
    const nextTop = Math.max(dropdownPosition.boundaryTop, triggerRect.top - dropdownRect.height - 4);

    if (Math.abs(nextTop - dropdownPosition.top) < 0.5) return;

    setDropdownPosition((current) => {
      if (!current || current.placement !== 'top') return current;
      return { ...current, top: nextTop };
    });
  }, [
    dropdownPosition?.boundaryTop,
    dropdownPosition?.placement,
    dropdownPosition?.top,
    filteredGroups.length,
    isOpen,
    showCreateOption,
  ]);

  const dropdown = isOpen && dropdownPosition && typeof document !== 'undefined'
    ? createPortal(
        <div
          ref={dropdownRef}
          style={{
            top: dropdownPosition.top,
            left: dropdownPosition.left,
            width: dropdownPosition.width,
            maxHeight: dropdownPosition.maxHeight,
          }}
          className={cn(
            'fixed z-[80] bg-card border border-border',
            'rounded-lg shadow-2xl overflow-y-auto',
            'flex flex-col'
          )}
        >
          {/* "No Group" option */}
          <button
            onClick={() => handleSelect(null)}
            className={cn(
              'w-full px-3 py-2 text-left text-sm',
              'flex items-center gap-2 transition-colors',
              selectedGroupId === null
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:bg-accent'
            )}
          >
            <Icon name="x" size={14} />
            <span>{i18n.t('project.noGroup', 'No Group')}</span>
          </button>

          {/* Existing groups */}
          {filteredGroups.map((group) => (
            <button
              key={group.id}
              onClick={() => handleSelect(group.id)}
              className={cn(
                'w-full px-3 py-2 text-left text-sm',
                'flex items-center gap-2 transition-colors',
                selectedGroupId === group.id
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent'
              )}
            >
              <Icon name="layers" size={14} />
              <span>{group.name}</span>
            </button>
          ))}

          {/* Create new group option */}
          {showCreateOption && (
            <>
              <div className="border-t border-border my-1" />
              <button
                onClick={handleCreateNew}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm',
                  'flex items-center gap-2 transition-colors',
                  'text-primary hover:bg-accent'
                )}
              >
                <Icon name="plus" size={14} />
                <span>{i18n.t('project.createGroupOption', 'Create "{{name}}"', { name: query })}</span>
              </button>
            </>
          )}

          {filteredGroups.length === 0 && !showCreateOption && (
            <div className="px-3 py-2 text-sm text-muted-foreground">
              {i18n.t('project.noGroupsFound', 'No groups found')}
            </div>
          )}
        </div>,
        document.body
      )
    : null;

  return (
    <div ref={containerRef} className={cn('relative', className)}>
      {/* Trigger/Input */}
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={displayValue}
          onChange={handleInputChange}
          onFocus={() => setIsOpen(true)}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          className={cn(
            'w-full bg-muted border border-border rounded-lg px-3 py-2',
            'text-sm text-foreground placeholder:text-muted-foreground',
            'focus:outline-none focus:border-primary',
            'pr-8'
          )}
        />
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2',
            'p-1 rounded transition-colors',
            isOpen ? 'bg-accent' : 'hover:bg-accent'
          )}
        >
          <Icon
            name={isOpen ? 'arrow-up' : 'chevron-down'}
            size={12}
            className="text-muted-foreground"
          />
        </button>
      </div>

      {dropdown}
    </div>
  );
};
