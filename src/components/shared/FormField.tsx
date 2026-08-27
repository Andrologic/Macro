import React, { useId } from 'react';
import { cn } from '../../utils/cn';

export interface FormFieldProps
  extends Omit<React.HTMLAttributes<HTMLDivElement>, 'children'> {
  label: React.ReactNode;
  htmlFor?: string;
  description?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  children: React.ReactNode;
}

/**
 * Keeps field labels, supporting text, and validation messages aligned across
 * the dense settings forms.
 */
export const FormField: React.FC<FormFieldProps> = ({
  label,
  htmlFor,
  description,
  error,
  required = false,
  children,
  className,
  ...props
}) => {
  const generatedId = useId().replace(/:/g, '');
  const descriptionId = `${generatedId}-description`;
  const errorId = `${generatedId}-error`;
  const messageIds = [description && descriptionId, error && errorId]
    .filter(Boolean)
    .join(' ');

  const child = React.Children.count(children) === 1
    ? React.Children.toArray(children)[0]
    : null;
  const field = React.isValidElement(child)
    ? child as React.ReactElement<React.HTMLAttributes<HTMLElement>>
    : null;
  const fieldId = htmlFor ?? field?.props.id;
  const enhancedChildren = field
    ? React.cloneElement(field, {
      id: field.props.id ?? fieldId,
      'aria-describedby': [field.props['aria-describedby'], messageIds]
        .filter(Boolean)
        .join(' ') || undefined,
      'aria-invalid': error ? true : field.props['aria-invalid'],
    })
    : children;

  return (
    <div
      data-form-field="true"
      data-invalid={error ? 'true' : undefined}
      className={cn('space-y-1.5', className)}
      {...props}
    >
      <label
        htmlFor={fieldId}
        className="flex items-center gap-1 text-xs font-medium text-foreground"
      >
        {label}
        {required && (
          <span aria-hidden="true" className="text-destructive">
            *
          </span>
        )}
      </label>
      {description && (
        <p id={descriptionId} className="text-xs leading-relaxed text-muted-foreground">
          {description}
        </p>
      )}
      {enhancedChildren}
      {error && (
        <p id={errorId} role="alert" className="text-xs leading-relaxed text-destructive">
          {error}
        </p>
      )}
    </div>
  );
};

FormField.displayName = 'FormField';
