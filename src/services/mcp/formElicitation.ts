import type { McpElicitationPrompt } from '../../types/generated/ipc';
import type { JsonValue } from '../../types/generated/ipc/serde_json/JsonValue';

type JsonObject = Record<string, JsonValue>;
export type FormDraft = Record<string, string | string[]>;
export type FormError = 'required' | 'invalid' | 'minimum' | 'maximum' | 'choice' | 'duplicate';
export type FormField = {
  name: string;
  label: string;
  description?: string;
  required: boolean;
  kind: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  format?: 'email' | 'uri' | 'date' | 'date-time';
  choices?: Array<{ value: string; label: string }>;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  minItems?: number;
  maxItems?: number;
  defaultValue?: JsonValue;
};
export type FormPrompt = {
  id: string;
  message: string;
  title?: string;
  description?: string;
  fields: FormField[];
  blockedForSecrets: boolean;
};

const isObject = (value: unknown): value is JsonObject =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const onlyKeys = (value: JsonObject, keys: string[]) =>
  Object.keys(value).every((key) => keys.includes(key));
const optionalText = (value: unknown) => value === undefined || typeof value === 'string';
const optionalCount = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
const optionalNumber = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isFinite(value));
const optionalInteger = (value: unknown) =>
  value === undefined || (typeof value === 'number' && Number.isSafeInteger(value));
const orderedChoices = (values: unknown, labels?: unknown): FormField['choices'] | null => {
  if (!Array.isArray(values) || !values.length ||
      (labels !== undefined && (!Array.isArray(labels) || labels.length !== values.length))) return null;
  const seen = new Set<string>();
  const choices: NonNullable<FormField['choices']> = [];
  for (const [index, value] of values.entries()) {
    if (typeof value !== 'string' || seen.has(value)) return null;
    const label = labels === undefined ? value : labels[index];
    if (typeof label !== 'string') return null;
    seen.add(value);
    choices.push({ value, label });
  }
  return choices;
};
const titledChoices = (items: unknown): FormField['choices'] | null => {
  if (!Array.isArray(items) || !items.length) return null;
  const values: string[] = [];
  const labels: string[] = [];
  for (const item of items) {
    if (!isObject(item) || !onlyKeys(item, ['const', 'title']) ||
        Object.keys(item).length !== 2 || typeof item.const !== 'string' ||
        typeof item.title !== 'string') return null;
    values.push(item.const);
    labels.push(item.title);
  }
  return orderedChoices(values, labels);
};

function parseField(name: string, value: unknown, required: boolean): FormField | null {
  if (!isObject(value) || typeof value.type !== 'string' ||
      !optionalText(value.title) || !optionalText(value.description)) return null;
  const field: FormField = {
    name, label: typeof value.title === 'string' ? value.title : name,
    description: typeof value.description === 'string' ? value.description : undefined,
    required, kind: value.type as FormField['kind'],
  };
  if (value.type === 'string') {
    if (!onlyKeys(value, ['type', 'title', 'description', 'default', 'minLength', 'maxLength', 'format', 'enum', 'enumNames', 'oneOf']) ||
        !optionalCount(value.minLength) || !optionalCount(value.maxLength) ||
        (value.minLength !== undefined && value.maxLength !== undefined && (value.minLength as number) > (value.maxLength as number)) ||
        (value.format !== undefined && !['email', 'uri', 'date', 'date-time'].includes(String(value.format))) ||
        (value.enum !== undefined && value.oneOf !== undefined) ||
        (value.enumNames !== undefined && value.enum === undefined)) return null;
    field.minLength = value.minLength as number | undefined;
    field.maxLength = value.maxLength as number | undefined;
    field.format = value.format as FormField['format'];
    if (value.enum !== undefined || value.oneOf !== undefined) {
      field.choices = value.enum !== undefined
        ? orderedChoices(value.enum, value.enumNames) ?? undefined
        : titledChoices(value.oneOf) ?? undefined;
      if (!field.choices) return null;
    }
  } else if (value.type === 'number' || value.type === 'integer') {
    if (!onlyKeys(value, ['type', 'title', 'description', 'default', 'minimum', 'maximum']) ||
        !(value.type === 'integer' ? optionalInteger(value.minimum) && optionalInteger(value.maximum)
          : optionalNumber(value.minimum) && optionalNumber(value.maximum)) ||
        (value.minimum !== undefined && value.maximum !== undefined && (value.minimum as number) > (value.maximum as number))) return null;
    field.minimum = value.minimum as number | undefined;
    field.maximum = value.maximum as number | undefined;
  } else if (value.type === 'boolean') {
    if (!onlyKeys(value, ['type', 'title', 'description', 'default'])) return null;
  } else if (value.type === 'array') {
    if (!onlyKeys(value, ['type', 'title', 'description', 'default', 'items', 'minItems', 'maxItems']) ||
        !isObject(value.items) || !optionalCount(value.minItems) || !optionalCount(value.maxItems) ||
        (value.minItems !== undefined && value.maxItems !== undefined && (value.minItems as number) > (value.maxItems as number))) return null;
    if (onlyKeys(value.items, ['type', 'enum']) && value.items.type === 'string') {
      field.choices = orderedChoices(value.items.enum) ?? undefined;
    } else if (onlyKeys(value.items, ['anyOf'])) {
      field.choices = titledChoices(value.items.anyOf) ?? undefined;
    }
    if (!field.choices) return null;
    field.minItems = value.minItems as number | undefined;
    field.maxItems = value.maxItems as number | undefined;
  } else return null;
  if (value.default !== undefined) {
    if (checkValue(field, value.default) !== null) return null;
    field.defaultValue = value.default;
  }
  return field;
}

// Fail closed on fields that appear to solicit credentials. No raw request or
// response is logged or persisted; Rust still validates every accepted value.
const SECRET_HINT = /(?:password|passphrase|secret|credential|api[\s_-]*key|private[\s_-]*key|access[\s_-]*token|auth[\s_-]*token|mot de passe|clé[\s_-]*api|clé[\s_-]*privée|jeton d'accès|passwort|contraseña|パスワード|비밀번호)/i;

export function parseFormPrompt(prompt: McpElicitationPrompt): FormPrompt | null {
  const request = prompt.request;
  if (!isObject(request) || request.method !== 'elicitation/create' || !isObject(request.params)) return null;
  const params = request.params;
  if (!onlyKeys(params, ['mode', 'message', 'requestedSchema', '_meta']) ||
      (params.mode !== undefined && params.mode !== 'form') ||
      typeof params.message !== 'string' || !isObject(params.requestedSchema) ||
      (params._meta !== undefined && !isObject(params._meta))) return null;
  const schema = params.requestedSchema;
  if (!onlyKeys(schema, ['$schema', 'type', 'properties', 'required', 'title', 'description']) ||
      schema.type !== 'object' || !isObject(schema.properties) ||
      !optionalText(schema.title) || !optionalText(schema.description)) return null;
  if (schema.$schema !== undefined && ![
    'https://json-schema.org/draft/2020-12/schema',
    'https://json-schema.org/draft/2020-12/schema#',
  ].includes(String(schema.$schema))) return null;
  const properties = schema.properties as JsonObject;
  const required = schema.required === undefined ? [] : schema.required;
  if (!Array.isArray(required) || required.some((name) => typeof name !== 'string' || !(name in properties)) ||
      new Set(required).size !== required.length) return null;
  const fields: FormField[] = [];
  for (const [name, definition] of Object.entries(properties)) {
    const field = parseField(name, definition, required.includes(name));
    if (!field) return null;
    fields.push(field);
  }
  return {
    id: prompt.id,
    message: params.message,
    title: schema.title as string | undefined,
    description: schema.description as string | undefined,
    fields,
    blockedForSecrets: [params.message, String(schema.title ?? ''), String(schema.description ?? ''),
      ...fields.flatMap((field) => [field.name, field.label, field.description ?? ''])]
      .some((text) => SECRET_HINT.test(text)),
  };
}

function checkValue(field: FormField, value: unknown): FormError | null {
  if (field.kind === 'string') {
    if (typeof value !== 'string') return 'invalid';
    const length = Array.from(value).length;
    if (field.minLength !== undefined && length < field.minLength) return 'minimum';
    if (field.maxLength !== undefined && length > field.maxLength) return 'maximum';
    if (field.choices && !field.choices.some((choice) => choice.value === value)) return 'choice';
    if (field.format === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) return 'invalid';
    if (field.format === 'uri') {
      try { new URL(value); } catch { return 'invalid'; }
    }
    if (field.format === 'date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value)) return 'invalid';
    if (field.format === 'date-time' && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) ||
        Number.isNaN(Date.parse(value)))) return 'invalid';
  } else if (field.kind === 'number' || field.kind === 'integer') {
    if (typeof value !== 'number' || !Number.isFinite(value) ||
        (field.kind === 'integer' && !Number.isSafeInteger(value))) return 'invalid';
    if (field.minimum !== undefined && value < field.minimum) return 'minimum';
    if (field.maximum !== undefined && value > field.maximum) return 'maximum';
  } else if (field.kind === 'boolean') {
    if (typeof value !== 'boolean') return 'invalid';
  } else {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return 'invalid';
    if (field.minItems !== undefined && value.length < field.minItems) return 'minimum';
    if (field.maxItems !== undefined && value.length > field.maxItems) return 'maximum';
    if (new Set(value).size !== value.length) return 'duplicate';
    if (value.some((item) => !field.choices?.some((choice) => choice.value === item))) return 'choice';
  }
  return null;
}

export function initialFormDraft(prompt: FormPrompt): FormDraft {
  const draft: FormDraft = {};
  for (const field of prompt.fields) {
    if (field.defaultValue === undefined) continue;
    const value = field.defaultValue;
    draft[field.name] = Array.isArray(value) ? [...value] as string[] : String(value);
  }
  return draft;
}

export function validateFormDraft(prompt: FormPrompt, draft: FormDraft): {
  content: JsonObject | null;
  errors: Record<string, FormError>;
} {
  const content: JsonObject = {};
  const errors: Record<string, FormError> = {};
  for (const field of prompt.fields) {
    const raw = draft[field.name];
    if (raw === undefined || (raw === '' && field.kind !== 'string')) {
      if (field.required) errors[field.name] = 'required';
      continue;
    }
    let value: JsonValue;
    if (field.kind === 'array') value = raw;
    else if (field.kind === 'boolean') value = raw === 'true' ? true : raw === 'false' ? false : null;
    else if (field.kind === 'number' || field.kind === 'integer') value = typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : null;
    else value = raw;
    const error = checkValue(field, value);
    if (error) errors[field.name] = error;
    else content[field.name] = value;
  }
  return { content: Object.keys(errors).length ? null : content, errors };
}
