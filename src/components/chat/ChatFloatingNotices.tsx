import React from 'react';
import { cn } from '../../utils/cn';
import { Icon, type IconName } from '../ui/Icon';

type ChatFloatingNoticeTone = 'info' | 'warning' | 'neutral';

const toneClasses: Record<ChatFloatingNoticeTone, string> = {
  info: 'border-sky-500/25 text-foreground',
  warning: 'border-amber-500/30 text-amber-700 dark:text-amber-300',
  neutral: 'border-border text-muted-foreground',
};

const iconClasses: Record<ChatFloatingNoticeTone, string> = {
  info: 'text-sky-400',
  warning: 'text-amber-500 dark:text-amber-300',
  neutral: 'text-muted-foreground',
};

export const ChatFloatingNoticeStack: React.FC<React.PropsWithChildren> = ({ children }) => (
  <div className="pointer-events-none relative z-20 h-0" data-chat-floating-notices="true">
    <div className="absolute inset-x-3 bottom-3 flex justify-center">
      <div className="pointer-events-auto flex max-h-[40vh] w-full max-w-2xl flex-col gap-2 overflow-y-auto">
        {children}
      </div>
    </div>
  </div>
);

interface ChatFloatingNoticeProps extends React.PropsWithChildren {
  icon: IconName;
  tone?: ChatFloatingNoticeTone;
  testId?: string;
}

export const ChatFloatingNotice: React.FC<ChatFloatingNoticeProps> = ({
  children,
  icon,
  tone = 'info',
  testId,
}) => (
  <div
    data-testid={testId}
    data-chat-floating-notice="true"
    data-chat-floating-notice-tone={tone}
    role="status"
    className={cn(
      'flex w-full items-start gap-2 rounded-xl border bg-background/90 px-3 py-2 text-xs shadow-lg shadow-black/15 backdrop-blur',
      toneClasses[tone],
    )}
  >
    <Icon name={icon} size={14} className={cn('mt-0.5 shrink-0', iconClasses[tone])} />
    <div className="min-w-0 flex-1">{children}</div>
  </div>
);
