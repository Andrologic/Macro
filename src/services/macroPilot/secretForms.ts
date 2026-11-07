export function secretForms(values: string[]): string[] {
  const result = new Set<string>();
  const add = (value: string) => {
    if (!value) return;
    result.add(value); result.add(encodeURIComponent(value)); result.add(JSON.stringify(value).slice(1, -1));
    const bytes = new TextEncoder().encode(value);
    let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    const base64 = btoa(binary); result.add(base64); result.add(base64.replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, ''));
  };
  for (const value of values) {
    add(value);
    // Some existing vault entries are JSON OAuth token bundles.
    if (value.startsWith('{') || value.startsWith('[')) {
      try {
        const pending: unknown[] = [JSON.parse(value)];
        while (pending.length) {
          const item = pending.pop();
          if (typeof item === 'string') add(item);
          else if (item && typeof item === 'object') pending.push(...Object.values(item));
        }
      } catch { /* The raw non-JSON value is still checked. */ }
    }
  }
  const forms = [...result].sort();
  if (forms.length > 4096 || forms.reduce((size, value) => size + new TextEncoder().encode(value).length, 0) > 1024 * 1024) throw new Error('resource_limit');
  return forms;
}
