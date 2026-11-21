export function run(request: {operation: string; primary: Uint8Array; annexes: Record<string, Uint8Array>}): Promise<{ report: unknown; artifacts: Record<string, Uint8Array> }>;
export function parse(bytes: Uint8Array): {tree: unknown; spans: Map<string, {start: number; end: number}>; bytes: Uint8Array; error?: {byte: number}};
export function stringify(value: unknown): string;
