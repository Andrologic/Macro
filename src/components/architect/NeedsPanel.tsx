import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { useAppStore } from '../../stores/useAppStore';
import { useChatStore } from '../../stores/useChatStore';
import type { NeedCategory } from '../../types';
import { Icon, IconName } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { NeedDetailsModal } from '../modals/NeedDetailsModal.tsx';

interface NeedsPanelProps {
  className?: string;
}

const CATEGORY_ICONS: Record<NeedCategory, IconName> = {
  functional: 'target',
  technical: 'code',
  ux: 'palette',
  performance: 'zap',
  security: 'shield',
  data: 'database',
  business: 'milestone',
  other: 'more-horizontal',
};

const CATEGORY_COLORS: Record<NeedCategory, string> = {
  functional: 'text-blue-500',
  technical: 'text-slate-500',
  ux: 'text-purple-500',
  performance: 'text-amber-500',
  security: 'text-red-500',
  data: 'text-emerald-500',
  business: 'text-indigo-500',
  other: 'text-muted-foreground',
};

/**
 * NeedsPanel - Displays project requirements/needs in Architect mode
 * 
 * PERFORMANCE: Lazy loaded via ModeRouter, only rendered when Architect mode is active
 */
const NeedsPanel: React.FC<NeedsPanelProps> = ({ className }) => {
  const { t } = useTranslation();
  const { needs, selectNeed, selectedNeedId } = useNeedsStore();
  const { activeArchitectPlanId } = useAppStore();
  const [filter, setFilter] = useState<'all' | NeedCategory>('all');
  const [isModalOpen, setIsModalOpen] = useState(false);

  const scopedNeeds = useMemo(() => {
    if (!activeArchitectPlanId) return [];
    return needs.filter((need) => need.planId === activeArchitectPlanId);
  }, [needs, activeArchitectPlanId]);

  const filteredNeeds = useMemo(() => {
    if (filter === 'all') return scopedNeeds;
    return scopedNeeds.filter((n) => n.category === filter);
  }, [scopedNeeds, filter]);

  const handleNeedClick = (needId: string) => {
    const need = needs.find((n) => n.id === needId);
    if (!need) return;
    const { addComposerContextRef } = useChatStore.getState();
    addComposerContextRef({
      id: need.id,
      kind: 'need',
      title: need.title,
      subtitle: need.category,
      data: need,
    });
  };

  const handleCloseModal = () => {
    setIsModalOpen(false);
    selectNeed(null);
  };

  return (
    <aside className={cn("h-full w-full bg-card border-r border-border flex flex-col", className)}>
      {/* Header */}
      <div className="h-12 border-b border-border flex items-center justify-between px-4 shrink-0">
        <h1 className="text-sm font-semibold text-foreground flex items-center gap-2">
          <Icon name="list" size={16} className="text-primary" />
          {t('architect.needs', 'Identified Needs')}
          <span className="text-xs text-muted-foreground px-2 py-0.5 bg-muted rounded-full ml-1">
            {scopedNeeds.length}
          </span>
        </h1>
      </div>

      {/* Filter Tabs */}
      <div className="px-3 py-2 border-b border-border flex gap-1 overflow-x-auto no-scrollbar shrink-0">
        <button
          onClick={() => setFilter('all')}
          className={cn(
            'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors shrink-0 inline-flex items-center justify-center leading-none',
            filter === 'all'
              ? 'bg-primary/10 text-primary'
              : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          )}
        >
          All
        </button>
        {(['functional', 'technical', 'ux', 'performance', 'security', 'data', 'business', 'other'] as NeedCategory[]).map((cat) => (
          <button
            key={cat}
            onClick={() => setFilter(cat)}
            className={cn(
              'px-2.5 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 shrink-0',
              filter === cat
                ? 'bg-accent text-foreground'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground'
            )}
          >
            <Icon name={CATEGORY_ICONS[cat]} size={12} className={CATEGORY_COLORS[cat]} />
            <span className="capitalize">{cat}</span>
          </button>
        ))}
      </div>

      {/* Needs List */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {filteredNeeds.length === 0 ? (
          <div className="h-full flex flex-col items-center justify-center text-muted-foreground opacity-50 p-4 text-center">
            <Icon name="sparkles" size={32} className="mb-2" />
            <p className="text-sm">No needs identified for this project yet.</p>
            <p className="text-xs mt-1">Chat with the Architect to uncover project requirements.</p>
          </div>
        ) : (
          filteredNeeds.map((need) => (
            <div
              key={need.id}
              onClick={() => handleNeedClick(need.id)}
              className={cn(
                "group relative p-3 rounded-lg border transition-all duration-200 cursor-pointer hover:shadow-sm",
                selectedNeedId === need.id
                  ? "bg-accent border-primary/50"
                  : "bg-card border-border hover:border-border/80 hover:bg-accent/50"
              )}
            >
              <div className="flex items-start justify-between gap-3 mb-1.5">
                <h3 className="text-sm font-medium text-foreground leading-tight line-clamp-2">
                  {need.title}
                </h3>
                <div className="w-6 h-6 rounded-md flex items-center justify-center bg-muted border border-border/50 shrink-0">
                  <Icon name={CATEGORY_ICONS[need.category]} size={12} className="text-muted-foreground" />
                </div>
              </div>

              <p className="text-xs text-muted-foreground line-clamp-2 mb-2">
                {need.description}
              </p>

              <div className="flex items-center gap-2">
                <span className={cn(
                  "text-[10px] uppercase font-bold tracking-wider px-1.5 py-0.5 rounded border",
                  need.priority === 'high' ? "border-red-500/20 text-red-500 bg-red-500/5" :
                    need.priority === 'medium' ? "border-amber-500/20 text-amber-500 bg-amber-500/5" :
                      "border-emerald-500/20 text-emerald-500 bg-emerald-500/5"
                )}>
                  {need.priority}
                </span>
                {need.tags.slice(0, 2).map(tag => (
                  <span key={tag} className="text-[10px] text-muted-foreground bg-secondary px-1.5 py-0.5 rounded">
                    #{tag}
                  </span>
                ))}
                {need.tags.length > 2 && (
                  <span className="text-[10px] text-muted-foreground">+{need.tags.length - 2}</span>
                )}
              </div>
            </div>
          ))
        )}
      </div>

      {/* Modal */}
      {isModalOpen && selectedNeedId && (
        <NeedDetailsModal
          needId={selectedNeedId}
          isOpen={isModalOpen}
          onClose={handleCloseModal}
        />
      )}
    </aside>
  );
};

// Export both named and default for lazy loading compatibility
export default NeedsPanel;
