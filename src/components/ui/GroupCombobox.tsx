import React, { useState, useRef, useEffect } from 'react';
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

export const GroupCombobox: React.FC<GroupComboboxProps> = ({
  projectGroups,
  selectedGroupId,
  onSelect,
  onCreateGroup,
  className,
  placeholder = 'Select a group...',
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const selectedGroup = projectGroups.find((g) => g.id === selectedGroupId);
  const displayValue = isCreating ? query : (selectedGroup?.name || '');

  const filteredGroups = projectGroups.filter((group) =>
    group.name.toLowerCase().includes(query.toLowerCase())
  );

  const hasMatch = filteredGroups.some((g) => g.name.toLowerCase() === query.toLowerCase());
  const showCreateOption = query.length > 0 && !hasMatch && onCreateGroup;

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
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
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
            'w-full bg-zinc-800 border border-zinc-700 rounded-lg px-3 py-2',
            'text-sm text-zinc-200 placeholder-zinc-500',
            'focus:outline-none focus:border-indigo-500',
            'pr-8'
          )}
        />
        <button
          onClick={() => setIsOpen(!isOpen)}
          className={cn(
            'absolute right-2 top-1/2 -translate-y-1/2',
            'p-1 rounded transition-colors',
            isOpen ? 'bg-zinc-700' : 'hover:bg-zinc-700'
          )}
        >
          <Icon
            name={isOpen ? 'arrow-up' : 'chevron-down'}
            size={12}
            className="text-zinc-500"
          />
        </button>
      </div>

      {/* Dropdown */}
      {isOpen && (
        <div
          className={cn(
            'absolute z-50 w-full mt-1 bg-zinc-800 border border-zinc-700',
            'rounded-lg shadow-xl max-h-60 overflow-y-auto',
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
                ? 'bg-indigo-500 text-white'
                : 'text-zinc-300 hover:bg-zinc-700'
            )}
          >
            <Icon name="x" size={14} />
            <span>No Group</span>
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
                  ? 'bg-indigo-500 text-white'
                  : 'text-zinc-300 hover:bg-zinc-700'
              )}
            >
              <Icon name="folder" size={14} />
              <span>{group.name}</span>
            </button>
          ))}

          {/* Create new group option */}
          {showCreateOption && (
            <>
              <div className="border-t border-zinc-700 my-1" />
              <button
                onClick={handleCreateNew}
                className={cn(
                  'w-full px-3 py-2 text-left text-sm',
                  'flex items-center gap-2 transition-colors',
                  'text-indigo-400 hover:bg-zinc-700'
                )}
              >
                <Icon name="plus" size={14} />
                <span>Create "{query}"</span>
              </button>
            </>
          )}

          {filteredGroups.length === 0 && !showCreateOption && (
            <div className="px-3 py-2 text-sm text-zinc-500">
              No groups found
            </div>
          )}
        </div>
      )}
    </div>
  );
};
