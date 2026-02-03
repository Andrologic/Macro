import React from 'react';

interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  label?: string;
  children: React.ReactNode;
  fullWidth?: boolean;
  className?: string;
}

export function Select({
  label,
  children,
  fullWidth = true,
  className = '',
  ...props
}: SelectProps) {
  const baseClassName = `
    bg-background border border-border rounded-lg px-3 py-2 
    text-sm text-foreground focus:outline-none focus:border-primary focus:ring-2 focus:ring-primary/20
    appearance-none cursor-pointer
    transition-all duration-200
    bg-no-repeat
  `;

  const widthClassName = fullWidth ? 'w-full' : '';

  return (
    <div className={widthClassName}>
      {label && (
        <label className="block text-sm text-muted-foreground mb-2">
          {label}
        </label>
      )}
      <select
        className={`${baseClassName} ${widthClassName} ${className}`.trim()}
        {...props}
      >
        {children}
      </select>
    </div>
  );
}
