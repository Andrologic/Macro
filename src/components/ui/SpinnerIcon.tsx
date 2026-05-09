import React from 'react';

import { cn } from '../../utils/cn';
import { Icon } from './Icon';

interface SpinnerIconProps {
  size?: number | string;
  className?: string;
  label?: string;
}

export const SpinnerIcon: React.FC<SpinnerIconProps> = ({
  size = 16,
  className,
  label,
}) => (
  <span
    className="inline-flex shrink-0 items-center justify-center"
    data-spinner-icon="true"
    {...(label
      ? { role: 'status' as const, 'aria-label': label }
      : { 'aria-hidden': true })}
  >
    <Icon
      name="loader"
      size={size}
      className={cn('origin-center animate-spin', className)}
    />
  </span>
);

export default SpinnerIcon;
