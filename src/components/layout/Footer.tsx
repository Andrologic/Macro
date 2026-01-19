import React from 'react';
import { Icon } from '../ui/Icon';

export const Footer: React.FC = () => {
  return (
    <footer className="h-8 bg-zinc-900 border-t border-zinc-800 flex items-center justify-between px-4 text-xs text-zinc-500">
      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Icon name="shield" size={12} className="text-emerald-500" />
          Online
        </span>
        <span className="flex items-center gap-1">
          <Icon name="zap" size={12} className="text-indigo-500" />
          AI Ready
        </span>
      </div>

      <div className="flex items-center gap-3">
        <span className="flex items-center gap-1">
          <Icon name="cpu" size={12} />
          12% CPU
        </span>
        <span className="flex items-center gap-1">
          <Icon name="code" size={12} />
          512MB
        </span>
        <span className="text-zinc-600">v0.1.0</span>
      </div>
    </footer>
  );
};
