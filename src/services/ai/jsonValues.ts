import {
  type StreamMessage,
} from './contracts';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// One contract-owned syntax/duplicate-key implementation for E and F.
export { parseStoredJsonStrict } from '../../../contracts/macro-pilot/v2/strict-json.mjs';

export const deepCloneJsonValue = <T,>(value: T): T => {
  if (!isRecord(value) && !Array.isArray(value)) {
    return value;
  }

  return JSON.parse(JSON.stringify(value)) as T;
};

export const cloneStreamMessage = (message: StreamMessage): StreamMessage =>
  JSON.parse(JSON.stringify(message)) as StreamMessage;

export const cloneProviderInputItems = (items?: unknown[] | null): unknown[] | undefined => {
  if (!Array.isArray(items) || items.length === 0) {
    return undefined;
  }

  return items.map((item) =>
    item && typeof item === 'object'
      ? JSON.parse(JSON.stringify(item))
      : item
  );
};
