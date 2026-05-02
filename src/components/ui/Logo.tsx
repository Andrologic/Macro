import React from 'react';
import { cn } from '../../utils/cn';

interface LogoProps {
  size?: number | string;
  className?: string;
}

export const Logo: React.FC<LogoProps> = ({ size = 24, className }) => {
  const resolvedSize = typeof size === 'number' ? `${size}px` : size;

  return (
    <span
      aria-hidden="true"
      className={cn(className)}
      style={{
        display: 'inline-block',
        width: resolvedSize,
        height: resolvedSize,
        background:
          'linear-gradient(135deg, rgb(var(--primary)) 0%, color-mix(in srgb, rgb(var(--primary)), black 20%) 100%)',
        maskImage: "url('/logo.svg')",
        maskRepeat: 'no-repeat',
        maskPosition: 'center',
        maskSize: 'contain',
        WebkitMaskImage: "url('/logo.svg')",
        WebkitMaskRepeat: 'no-repeat',
        WebkitMaskPosition: 'center',
        WebkitMaskSize: 'contain',
      }}
    />
  );
};
