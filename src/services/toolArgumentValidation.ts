import type { JsonSchema } from '../shared/macroToolRegistry';

export interface ToolArgumentValidationIssue {
  path: string;
  message: string;
}

const valueType = (value: unknown): string => {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
};

const validateValue = (
  value: unknown,
  schema: JsonSchema,
  path: string,
  issues: ToolArgumentValidationIssue[],
): void => {
  if (!('type' in schema) || !schema.type) return;

  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      issues.push({ path, message: `expected object, received ${valueType(value)}` });
      return;
    }

    const record = value as Record<string, unknown>;
    for (const requiredKey of schema.required ?? []) {
      const requiredValue = record[requiredKey];
      if (requiredValue === undefined || requiredValue === null) {
        issues.push({ path: `${path}.${requiredKey}`, message: 'required value is missing' });
      }
    }

    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (record[key] !== undefined) {
        validateValue(record[key], propertySchema, `${path}.${key}`, issues);
      }
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) {
      issues.push({ path, message: `expected array, received ${valueType(value)}` });
      return;
    }
    value.forEach((item, index) => validateValue(item, schema.items, `${path}[${index}]`, issues));
    return;
  }

  if (typeof value !== schema.type) {
    issues.push({ path, message: `expected ${schema.type}, received ${valueType(value)}` });
    return;
  }

  if (schema.enum && typeof value === 'string' && !schema.enum.includes(value)) {
    issues.push({ path, message: `expected one of: ${schema.enum.join(', ')}` });
  }
  if (
    schema.type === 'string' &&
    typeof value === 'string' &&
    schema.minLength !== undefined &&
    value.length < schema.minLength
  ) {
    issues.push({ path, message: `expected at least ${schema.minLength} character(s)` });
  }
};

export const validateToolArguments = (
  args: unknown,
  schema: JsonSchema,
): ToolArgumentValidationIssue[] => {
  const issues: ToolArgumentValidationIssue[] = [];
  validateValue(args, schema, '$', issues);
  return issues;
};

export const formatToolArgumentValidationError = (
  toolName: string,
  issues: ToolArgumentValidationIssue[],
): string =>
  `Invalid arguments for tool ${toolName}: ${issues
    .map((issue) => `${issue.path} ${issue.message}`)
    .join('; ')}.`;
