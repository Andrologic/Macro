import {
  type StreamMessage,
} from './contracts';

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

/** JSON.parse owns syntax. This one structural pass detects duplicate decoded
 * keys before any provider decoder can accept JSON.parse's last value. The
 * caller admits both the parsed graph and key sets before materializing raw. */
export function parseStoredJsonStrict(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  const scopes: Array<Set<string> | null> = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '{') scopes.push(new Set());
    else if (char === '[') scopes.push(null);
    else if (char === '}' || char === ']') scopes.pop();
    else if (char === '"') {
      const start = i++;
      while (raw[i] !== '"') { if (raw[i] === '\\') i++; i++; }
      let next = i + 1;
      while (/\s/.test(raw[next] ?? '') && next < raw.length) next++;
      if (raw[next] === ':') {
        const key: string = JSON.parse(raw.slice(start, i + 1));
        const keys = scopes.at(-1);
        if (!keys || keys.has(key)) throw new Error('ambiguous_json');
        keys.add(key);
      }
    }
  }
  return value;
}

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
