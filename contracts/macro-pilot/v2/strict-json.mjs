/** JSON.parse owns syntax. One structural pass rejects duplicate decoded keys.
 * Callers must admit raw bytes, the parsed graph and key sets before calling.
 * This parser does not inspect provider grammars or enforce a content policy. */
export function parseStoredJsonStrict(raw) {
  let value;
  try {
    if (typeof raw !== 'string') throw new Error();
    value = JSON.parse(raw);
  } catch { throw new Error('invalid_json'); }
  const scopes = [];
  for (let i = 0; i < raw.length; i++) {
    const char = raw[i];
    if (char === '{') scopes.push(new Set());
    else if (char === '[') scopes.push(null);
    else if (char === '}' || char === ']') scopes.pop();
    else if (char === '"') {
      const start = i++;
      while (raw[i] !== '"') { if (raw[i] === '\\') i++; i++; }
      let next = i + 1;
      while (next < raw.length && /\s/.test(raw[next])) next++;
      if (raw[next] === ':') {
        const key = JSON.parse(raw.slice(start, i + 1));
        const keys = scopes.at(-1);
        if (!keys || keys.has(key)) throw new Error('ambiguous_json');
        keys.add(key);
      }
    }
  }
  return value;
}
