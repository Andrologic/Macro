import type { ContentConversationFileCapture } from './contentProtocol';
import { inspectAttachmentImage } from './attachmentImagePolicy';
import { controlledText, type TextPolicy } from './conversationText';

export const FILE_LIMITS = { file: 2 * 1024 * 1024, chunk: 64 * 1024, captureMs: 5 * 60 * 1000,
  instanceMemory: 128 * 1024 * 1024, sessionMemory: 96 * 1024 * 1024, instanceCaptures: 64, sessionCaptures: 32, catalog: 2000, page: 64 } as const;

export function inspectAttachmentContent(bytes: Uint8Array, mime: string, policy: TextPolicy): ContentConversationFileCapture['content_state'] {
  if (bytes.length > FILE_LIMITS.file) return 'too_large';
  if (mime.startsWith('image/')) {
    const magic = String.fromCharCode(...bytes.subarray(0, 12));
    const valid = mime === 'image/png' ? bytes.subarray(0, 8).join(',') === '137,80,78,71,13,10,26,10' :
      mime === 'image/jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 :
      mime === 'image/gif' ? magic.startsWith('GIF87a') || magic.startsWith('GIF89a') :
      mime === 'image/webp' ? magic.startsWith('RIFF') && magic.slice(8) === 'WEBP' : false;
    if (!valid) return 'unsupported';
    // Inspect the complete binary representation too: image comments and metadata
    // may contain a native path or a credential after the first fragment.
    const inspection = { ...policy, inspectionBytes: FILE_LIMITS.file * 4 };
    const decoded = new TextDecoder().decode(bytes);
    let latin = ''; for (let i = 0; i < bytes.length; i += 8192) latin += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return controlledText(decoded, inspection, FILE_LIMITS.file * 4).content_state === 'complete' &&
      controlledText(latin, inspection, FILE_LIMITS.file * 4).content_state === 'complete' ? inspectAttachmentImage(bytes, mime) : 'withheld';
  }
  if (!mime.startsWith('text/') && !['application/json', 'application/xml', 'application/x-ndjson', 'application/javascript', 'application/yaml', 'application/x-yaml'].includes(mime)) return 'unsupported';
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (text.includes('\0')) return 'unsupported';
    return controlledText(text, { ...policy, inspectionBytes: FILE_LIMITS.file }, FILE_LIMITS.file).content_state === 'complete' ? 'available' : 'withheld';
  } catch { return 'unsupported'; }
}
