import React from 'react';
import { ThemeColors } from '../../../types/theme';
import { cn } from '../../../utils/cn';

interface ThemePreviewProps {
  colors: ThemeColors;
  isActive?: boolean;
}

export const ThemePreview: React.FC<ThemePreviewProps> = ({ colors, isActive }) => {
  return (
    <div 
      className={cn(
        "w-full aspect-[4/3] rounded-lg mb-2 overflow-hidden shadow-sm transition-opacity border border-border/10",
        isActive ? "ring-2 ring-primary ring-offset-1 ring-offset-background" : ""
      )}
      style={{
        backgroundColor: colors.background,
        color: colors.foreground
      }}
    >
      <div className="flex h-full w-full">
        {/* Sidebar Preview */}
        <div 
          className="w-1/3 h-full flex flex-col p-2 gap-2 border-r"
          style={{
            backgroundColor: colors.muted,
            borderColor: colors.border
          }}
        >
          {/* Logo / Brand */}
          <div 
            className="h-2 w-2/3 rounded-sm opacity-60"
            style={{ backgroundColor: colors.foreground }}
          />
          {/* Nav Item Active */}
          <div 
            className="h-2 w-full rounded-sm mt-1 opacity-80"
            style={{ backgroundColor: colors.primary }}
          />
           {/* Nav Item Inactive */}
           <div 
            className="h-2 w-3/4 rounded-sm opacity-40"
            style={{ backgroundColor: colors.mutedForeground }}
          />
        </div>

        {/* Content Preview */}
        <div className="flex-1 flex flex-col">
          {/* Header Preview */}
          <div 
            className="h-6 w-full border-b flex items-center px-2"
            style={{
              backgroundColor: colors.card,
              borderColor: colors.border
            }}
          >
             <div 
                className="h-1.5 w-1/4 rounded-sm opacity-50" 
                style={{ backgroundColor: colors.foreground }}
             />
          </div>

          {/* Main Body */}
          <div className="p-2 gap-2 flex flex-col">
            {/* Card Example */}
            <div 
              className="p-1.5 rounded-md border text-[var(--size-xxs)]"
              style={{
                backgroundColor: colors.card,
                borderColor: colors.border,
                color: colors.cardForeground
              }}
            >
              <div 
                className="h-1 w-1/2 rounded-full mb-1 opacity-80"
                style={{ backgroundColor: colors.primary }}
              />
              <div 
                className="h-1 w-3/4 rounded-full opacity-40"
                 style={{ backgroundColor: colors.mutedForeground }}
              />
            </div>

            {/* Button Example */}
            <div 
               className="h-3 w-1/3 rounded-[2px] self-end mt-auto"
               style={{ backgroundColor: colors.primary }}
            />
          </div>
        </div>
      </div>
    </div>
  );
};
