import type { AgsdlEnvelopeMetadata } from './design';

export type AgsdlExportFormat = 'source' | 'macro';
export function agsdlExport(source: string, annexes: Record<string, string>, metadata: AgsdlEnvelopeMetadata, name: string, format: AgsdlExportFormat) {
  const base = name.trim().replace(/[^\p{L}\p{N}._-]+/gu, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 100) || 'system';
  return {
    filename: `${base}.${format === 'source' ? 'agsdl' : 'macro-system'}.json`,
    content: format === 'source' ? source : JSON.stringify({ format: 'macro-agsdl-export', version: 1, name: name.trim(), agsdl: { source, annexes, ...metadata } }, null, 2),
  };
}
export function downloadAgsdlExport(file: ReturnType<typeof agsdlExport>) {
  const url = URL.createObjectURL(new Blob([file.content], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = file.filename;
  document.body.appendChild(anchor);
  try { anchor.click(); } finally {
    anchor.remove();
    // Allow the browser to begin reading the download before releasing its URL.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}
