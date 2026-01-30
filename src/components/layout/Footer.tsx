import React from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../ui/Icon';

export const Footer: React.FC = () => {
  const { t } = useTranslation();

  return (
    <footer className="h-8 bg-card border-t border-border flex items-center justify-between px-4 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Icon name="shield" size={12} className="text-emerald-500" />
          {t('footer.online')}
        </span>
        <span className="flex items-center gap-1">
          <Icon name="zap" size={12} className="text-primary" />
          {t('footer.aiReady')}
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Icon name="cpu" size={12} />
          12% {t('footer.cpu')}
        </span>
        <span className="flex items-center gap-1">
          <Icon name="code" size={12} />
          512MB
        </span>
        <span className="text-muted-foreground/70">v0.1.0</span>
      </div>
    </footer>
  );
};
