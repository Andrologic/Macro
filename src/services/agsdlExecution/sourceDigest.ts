export async function sourceDigest(authoredSource: string): Promise<string> {
  const bytes = new TextEncoder().encode(authoredSource);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}
