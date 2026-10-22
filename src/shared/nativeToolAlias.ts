/** Qualified OpenAI-compatible function names. This is a transport limit, not
 * an AgSDL syntax rule; authored names are never rewritten to satisfy it. */
export const isNativeToolAlias = (name: string): boolean => /^[A-Za-z0-9_-]{1,64}$/.test(name);
