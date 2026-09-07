// The upstream reader is synchronous. Hash each immutable input before entering it.
const hashes = new WeakMap();
export async function prepareHashes(inputs) {
  await Promise.all(inputs.map(async bytes => {
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    hashes.set(bytes, Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join(''));
  }));
}
export function hash(bytes) {
  const value = hashes.get(bytes);
  if (!value) throw new Error('AgSDL input was not hashed before validation');
  return value;
}
