import type { Citation } from '../stores/useCitationsStore';

export class AttachmentPersistenceError extends Error {
  constructor(readonly savedNames: string[], readonly failedName: string, cause: unknown) {
    super(`Could not save ${failedName}`, { cause });
  }
}

export const persistConversationAttachments = async (
  prepared: readonly PreparedConversationAttachment[],
  conversationId: string,
  persist: (citation: Omit<Citation, 'id' | 'timestamp'>) => Promise<string>,
): Promise<string[]> => {
  const ids: string[] = [];
  for (const attachment of prepared) {
    try {
      ids.push(await persist(toConversationFileCitation(attachment, {
        conversationId,
        messageId: `manual-${crypto.randomUUID()}`,
      })));
    } catch (error) {
      throw new AttachmentPersistenceError(
        prepared.slice(0, ids.length).map((item) => item.fileName),
        attachment.fileName,
        error,
      );
    }
  }
  return ids;
};

export const MAX_CONVERSATION_ATTACHMENT_FILES = 10;
export const MAX_CONVERSATION_ATTACHMENT_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES = 8 * 1024 * 1024;
const ATTACHMENT_SAMPLE_BYTES = 8 * 1024;

export const IMAGE_ATTACHMENT_ACCEPT = 'image/png,image/jpeg,image/gif,image/webp';

// Both composer and toolbox share the import slot, including quota checks.
let importingAttachments = false;
export const acquireAttachmentImport = (): (() => void) => {
  if (importingAttachments) throw new ConversationAttachmentError('import_busy');
  importingAttachments = true;
  return () => { importingAttachments = false; };
};

export const validateImageAttachments = async (
  files: readonly File[],
  existingCount: number,
  existingBytes: number,
): Promise<void> => {
  if (existingCount + files.length > MAX_CONVERSATION_ATTACHMENT_FILES) {
    throw new ConversationAttachmentError('too_many_files');
  }
  for (const file of files) {
    if (!IMAGE_ATTACHMENT_ACCEPT.split(',').includes(file.type)) {
      throw new ConversationAttachmentError('unsupported_type', file.name);
    }
    if (file.size > MAX_CONVERSATION_ATTACHMENT_FILE_BYTES) {
      throw new ConversationAttachmentError('file_too_large', file.name);
    }
  }
  if (existingBytes + files.reduce((sum, file) => sum + file.size, 0) > MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES) {
    throw new ConversationAttachmentError('total_too_large');
  }
  for (const file of files) {
    const bytes = new Uint8Array(await file.slice(0, 12).arrayBuffer());
    const ascii = String.fromCharCode(...bytes);
    const valid = file.type === 'image/png'
      ? bytes.slice(0, 8).join(',') === '137,80,78,71,13,10,26,10'
      : file.type === 'image/jpeg'
        ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
        : file.type === 'image/gif'
          ? ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')
          : ascii.startsWith('RIFF') && ascii.slice(8) === 'WEBP';
    if (!valid) throw new ConversationAttachmentError('binary_content', file.name);
  }
};

export const CONVERSATION_ATTACHMENT_EXTENSIONS = [
  'txt',
  'md',
  'markdown',
  'csv',
  'tsv',
  'json',
  'jsonl',
  'yaml',
  'yml',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'js',
  'jsx',
  'ts',
  'tsx',
  'mjs',
  'cjs',
  'py',
  'rb',
  'go',
  'rs',
  'java',
  'kt',
  'c',
  'cc',
  'cpp',
  'h',
  'hpp',
  'cs',
  'php',
  'sh',
  'bash',
  'zsh',
  'fish',
  'sql',
  'log',
  'env',
  'toml',
  'ini',
  'conf',
] as const;

const ACCEPTED_TEXT_EXTENSIONS = new Set<string>(CONVERSATION_ATTACHMENT_EXTENSIONS);
const ACCEPTED_APPLICATION_MIME_TYPES = new Set([
  'application/json',
  'application/xml',
  'application/x-ndjson',
  'application/javascript',
  'application/x-javascript',
  'application/yaml',
  'application/x-yaml',
]);

export const CONVERSATION_ATTACHMENT_ACCEPT = [
  'text/*',
  ...ACCEPTED_APPLICATION_MIME_TYPES,
  ...CONVERSATION_ATTACHMENT_EXTENSIONS.map((extension) => `.${extension}`),
].join(',');

export type ConversationAttachmentErrorCode =
  | 'import_busy'
  | 'too_many_files'
  | 'file_too_large'
  | 'total_too_large'
  | 'unsupported_type'
  | 'binary_content'
  | 'read_failed';

export class ConversationAttachmentError extends Error {
  constructor(
    readonly code: ConversationAttachmentErrorCode,
    readonly fileName?: string,
  ) {
    super(code);
    this.name = 'ConversationAttachmentError';
  }
}

export interface PreparedConversationAttachment {
  fileName: string;
  content: string;
  sizeBytes: number;
  mimeType: string;
}

export interface PrepareConversationAttachmentsOptions {
  existingBytes?: number;
  existingCount?: number;
}

const isSupportedTextFile = (file: File): boolean => {
  const mimeType = file.type.toLowerCase();
  if (mimeType.startsWith('text/') || ACCEPTED_APPLICATION_MIME_TYPES.has(mimeType)) {
    return true;
  }

  const extension = file.name.split('.').pop()?.toLowerCase();
  return Boolean(extension && ACCEPTED_TEXT_EXTENSIONS.has(extension));
};

const readBlobAsText = async (blob: Blob, fileName: string, partial = false): Promise<string> => {
  let bytes: ArrayBuffer;
  try {
    bytes = await blob.arrayBuffer();
  } catch {
    throw new ConversationAttachmentError('read_failed', fileName);
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes, { stream: partial });
  } catch {
    throw new ConversationAttachmentError('binary_content', fileName);
  }
};

const looksBinary = (sample: string): boolean => {
  if (sample.includes('\0')) return true;
  if (sample.length === 0) return false;

  let suspiciousControls = 0;
  for (const character of sample) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (
      codePoint < 32 &&
      codePoint !== 8 &&
      codePoint !== 9 &&
      codePoint !== 10 &&
      codePoint !== 12 &&
      codePoint !== 13
    ) {
      suspiciousControls += 1;
    }
  }
  return suspiciousControls / sample.length > 0.01;
};

export const prepareConversationAttachments = async (
  filesInput: FileList | readonly File[],
  options: PrepareConversationAttachmentsOptions = {},
): Promise<PreparedConversationAttachment[]> => {
  const files = Array.from(filesInput);
  const existingCount = Math.max(0, options.existingCount ?? 0);
  const existingBytes = Math.max(0, options.existingBytes ?? 0);

  if (existingCount + files.length > MAX_CONVERSATION_ATTACHMENT_FILES) {
    throw new ConversationAttachmentError('too_many_files');
  }

  let selectedBytes = 0;
  for (const file of files) {
    if (!isSupportedTextFile(file)) {
      throw new ConversationAttachmentError('unsupported_type', file.name);
    }
    if (file.size > MAX_CONVERSATION_ATTACHMENT_FILE_BYTES) {
      throw new ConversationAttachmentError('file_too_large', file.name);
    }
    selectedBytes += file.size;
  }

  if (existingBytes + selectedBytes > MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES) {
    throw new ConversationAttachmentError('total_too_large');
  }

  for (const file of files) {
    const sample = await readBlobAsText(
      file.slice(0, Math.min(file.size, ATTACHMENT_SAMPLE_BYTES)),
      file.name,
      file.size > ATTACHMENT_SAMPLE_BYTES,
    );
    if (looksBinary(sample)) {
      throw new ConversationAttachmentError('binary_content', file.name);
    }
  }

  const prepared: PreparedConversationAttachment[] = [];
  for (const file of files) {
    const content = await readBlobAsText(file, file.name);
    if (looksBinary(content)) {
      throw new ConversationAttachmentError('binary_content', file.name);
    }
    prepared.push({
      fileName: file.name,
      content,
      sizeBytes: file.size,
      mimeType: file.type || 'text/plain',
    });
  }
  return prepared;
};

export const toConversationFileCitation = (
  attachment: PreparedConversationAttachment,
  params: { conversationId: string; messageId: string },
): Omit<Citation, 'id' | 'timestamp'> => ({
  type: 'file',
  scope: 'context',
  source: attachment.fileName,
  title: attachment.fileName,
  snippet: attachment.content.slice(0, 1000) + (attachment.content.length > 1000 ? '...' : ''),
  content: attachment.content,
  path: attachment.fileName,
  sizeBytes: attachment.sizeBytes,
  messageId: params.messageId,
  conversationId: params.conversationId,
});
