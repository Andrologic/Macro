import React from 'react';
import { cn } from '../../utils/cn';

interface LogoProps {
  size?: number;
  className?: string;
}

export const Logo: React.FC<LogoProps> = ({ size = 20, className }) => {
  return (
    <img
      src="/logo.svg"
      alt="Macro"
      width={size}
      height={size}
      className={cn('inline-block', className)}
    />
  );
};
