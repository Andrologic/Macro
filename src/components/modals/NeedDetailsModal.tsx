import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNeedsStore } from '../../stores/useNeedsStore';
import { Icon } from '../ui/Icon';
import { ConfirmPromptModal } from '../ui/ConfirmPromptModal';
import { cn } from '../../utils/cn';
import type { NeedCategory } from '../../types';

interface NeedDetailsModalProps {
  needId: string;
  isOpen: boolean;
  onClose: () => void;
}

export const NeedDetailsModal: React.FC<NeedDetailsModalProps> = ({ needId, isOpen, onClose }) => {
  const { t } = useTranslation();
  const { getNeed, updateNeed, deleteNeed } = useNeedsStore();
  const need = getNeed(needId);

  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<NeedCategory>('other');
  const [priority, setPriority] = useState<'low' | 'medium' | 'high'>('medium');
  const [isDeleteConfirmOpen, setIsDeleteConfirmOpen] = useState(false);

  useEffect(() => {
    if (need) {
      setTitle(need.title);
      setDescription(need.description);
      setCategory(need.category);
      setPriority(need.priority);
    }
  }, [need]);

  if (!isOpen || !need) return null;

  const handleSave = () => {
    updateNeed(needId, {
      title,
      description,
      category,
      priority,
    });
    onClose();
  };

  const handleDelete = () => {
    deleteNeed(needId);
    setIsDeleteConfirmOpen(false);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="w-full max-w-lg bg-card border border-border shadow-2xl rounded-xl overflow-hidden animate-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border bg-muted/20">
          <div className="flex items-center gap-3">
             <div className="p-2 bg-primary/10 rounded-lg">
                <Icon name="search" size={18} className="text-primary" />
             </div>
             <div>
                <h2 className="text-lg font-semibold leading-none mb-1">
                   {t('need.details', 'Need Details')}
                </h2>
                <p className="text-xs text-muted-foreground">
                   ID: <span className="font-mono opacity-70">{need.id.slice(0, 8)}</span>
                </p>
             </div>
          </div>
          <button 
            onClick={onClose}
            className="p-2 hover:bg-accent rounded-full transition-colors"
          >
            <Icon name="x" size={18} className="text-muted-foreground" />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-4">
          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Title</label>
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 transition-all font-medium"
              placeholder="e.g. User Authentication"
            />
          </div>

          <div className="grid grid-cols-2 gap-4">
             <div className="space-y-2">
               <label className="text-sm font-medium text-muted-foreground">Category</label>
               <select
                 value={category}
                 onChange={(e) => setCategory(e.target.value as NeedCategory)}
                 className="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 text-sm"
               >
                 <option value="functional">Functional</option>
                 <option value="technical">Technical</option>
                 <option value="ux">UX / UI</option>
                 <option value="security">Security</option>
                 <option value="other">Other</option>
               </select>
             </div>

             <div className="space-y-2">
               <label className="text-sm font-medium text-muted-foreground">Priority</label>
               <div className="flex bg-muted/30 p-1 rounded-lg border border-border">
                  {(['low', 'medium', 'high'] as const).map(p => (
                     <button
                        key={p}
                        onClick={() => setPriority(p)}
                        className={cn(
                           "flex-1 py-1 text-xs font-medium rounded-md transition-all capitalize",
                           priority === p
                              ? "bg-background text-foreground shadow-sm ring-1 ring-border"
                              : "text-muted-foreground hover:text-foreground"
                        )}
                     >
                        {p}
                     </button>
                  ))}
               </div>
             </div>
          </div>

          <div className="space-y-2">
            <label className="text-sm font-medium text-muted-foreground">Description</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={5}
              className="w-full px-3 py-2 bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/20 resize-none text-sm leading-relaxed"
              placeholder="Describe the requirement in detail..."
            />
          </div>
        </div>

        {/* Footer */}
        <div className="bg-muted/30 px-6 py-4 border-t border-border flex items-center justify-between">
          <button
            onClick={() => setIsDeleteConfirmOpen(true)}
            className="flex items-center gap-2 px-3 py-2 text-red-500 hover:bg-red-500/10 rounded-lg transition-colors text-sm font-medium"
          >
            <Icon name="trash" size={14} />
            <span>Delete</span>
          </button>
          <div className="flex items-center gap-3">
            <button
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={handleSave}
              className="px-4 py-2 bg-primary text-primary-foreground text-sm font-medium rounded-lg hover:bg-primary/90 transition-colors shadow-sm"
            >
              Save Changes
            </button>
          </div>
        </div>
      </div>

      <ConfirmPromptModal
        isOpen={isDeleteConfirmOpen}
        title={t('common.delete', 'Delete')}
        description={t('common.confirmDelete', 'Are you sure you want to delete this need?')}
        confirmLabel={t('common.delete', 'Delete')}
        cancelLabel={t('common.cancel', 'Cancel')}
        confirmVariant="error"
        onCancel={() => setIsDeleteConfirmOpen(false)}
        onConfirm={handleDelete}
      />
    </div>
  );
};
