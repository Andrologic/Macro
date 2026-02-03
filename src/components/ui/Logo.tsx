import React, { useId } from 'react';
import { cn } from '../../utils/cn';

interface LogoProps {
  size?: number | string;
  className?: string;
  strokeWidth?: number;
}

export const Logo: React.FC<LogoProps> = ({ size = 24, className, strokeWidth = 2 }) => {
  const gradientId = useId();
  const safeGradientId = gradientId.replace(/:/g, '-');

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={cn(className)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id={safeGradientId} x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="rgb(var(--primary))" />
          <stop offset="100%" stopColor="color-mix(in srgb, rgb(var(--primary)), black 20%)" />
        </linearGradient>
      </defs>
      <g transform="rotate(-90 12 12)">
        <path
          d="M 21,12 4,4 c 2,5 2,11 0,16 z"
          stroke={`url(#${safeGradientId})`}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </g>
    </svg>
  );
};
