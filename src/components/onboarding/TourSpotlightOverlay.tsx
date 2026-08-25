import type React from 'react';
import type { TourSpotlightRect, TourViewport } from './tourGeometry';

interface TourSpotlightOverlayProps {
  rect: TourSpotlightRect | null;
  viewport: TourViewport;
}

const SPOTLIGHT_RADIUS = 12;

export const TourSpotlightOverlay: React.FC<TourSpotlightOverlayProps> = ({
  rect,
  viewport,
}) => {
  if (!rect) {
    return (
      <div className="absolute inset-0 bg-black/40 pointer-events-auto" />
    );
  }

  const maskPath = [
    `M 0 0 H ${viewport.width} V ${viewport.height} H 0 Z`,
    `M ${rect.left} ${rect.top} H ${rect.right} V ${rect.bottom} H ${rect.left} Z`,
  ].join(' ');

  return (
    <svg
      className="absolute left-0 top-0 pointer-events-none"
      width={viewport.width}
      height={viewport.height}
      viewBox={`0 0 ${viewport.width} ${viewport.height}`}
      aria-hidden="true"
      focusable="false"
    >
      <path
        d={maskPath}
        fill="rgba(0,0,0,0.40)"
        fillRule="evenodd"
        className=" pointer-events-auto"
      />
      <rect
        data-onboarding-highlight="true"
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        rx={SPOTLIGHT_RADIUS}
        ry={SPOTLIGHT_RADIUS}
        fill="none"
        stroke="rgb(var(--primary))"
        strokeOpacity={0.35}
        strokeWidth={3}
        vectorEffect="non-scaling-stroke"
        className="transition-all duration-300 ease-out"
      />
      <rect
        x={rect.left}
        y={rect.top}
        width={rect.width}
        height={rect.height}
        rx={SPOTLIGHT_RADIUS}
        ry={SPOTLIGHT_RADIUS}
        fill="none"
        stroke="rgb(var(--primary))"
        strokeOpacity={0.9}
        strokeWidth={1.5}
        vectorEffect="non-scaling-stroke"
        className="transition-all duration-300 ease-out"
      />
    </svg>
  );
};

export default TourSpotlightOverlay;
