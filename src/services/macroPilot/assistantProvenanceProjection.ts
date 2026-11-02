export async function fingerprint(messageId: string, content: string): Promise<string> {
  const input = new TextEncoder().encode(JSON.stringify([messageId, content]));
  return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', input)), byte => byte.toString(16).padStart(2, '0')).join('');
}
const object = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;


/** Validate a receipt already read in the same snapshot as its display content. */
export async function projectFinalProvenance(messageId: string, content: string, raw: string | null): Promise<string | null> {
  if (raw === null) return null;
  try {
    const record = object(JSON.parse(raw));
    if (!record || record.version !== 2 || record.source !== 'provider-output' ||
        !Number.isSafeInteger(record.start) || !Number.isSafeInteger(record.end) ||
        (record.start as number) < 0 || (record.end as number) <= (record.start as number) || (record.end as number) > content.length ||
        record.fingerprint !== await fingerprint(messageId, content)) return null;
    return content.slice(record.start as number, record.end as number);
  } catch { return null; }
}
