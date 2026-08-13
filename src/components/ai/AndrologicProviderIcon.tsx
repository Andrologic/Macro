import type { CSSProperties } from 'react';
import { MACRO_AI_PROVIDER_ICON_PATH } from '../../config/macroAi';
import { cn } from '../../utils/cn';

const maskStyle: CSSProperties = {
  WebkitMask: `url(${MACRO_AI_PROVIDER_ICON_PATH}) center / contain no-repeat`,
  mask: `url(${MACRO_AI_PROVIDER_ICON_PATH}) center / contain no-repeat`,
};

interface AndrologicProviderIconProps {
  className?: string;
}

export const AndrologicProviderIcon = ({ className }: AndrologicProviderIconProps) => (
  <span
    aria-hidden="true"
    className={cn('inline-block shrink-0 bg-current', className)}
    style={maskStyle}
  />
);
