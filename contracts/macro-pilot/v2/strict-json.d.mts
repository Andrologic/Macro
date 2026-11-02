/** Parse already admitted JSON, rejecting duplicate decoded object keys.
 * Throws fixed invalid_json or ambiguous_json diagnostics. Does not admit memory. */
export function parseStoredJsonStrict(raw: string): unknown;
