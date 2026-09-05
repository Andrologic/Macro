import { describe, expect, it } from 'bun:test';
import {
  CONVERSATION_ATTACHMENT_ACCEPT,
  ConversationAttachmentError,
  MAX_CONVERSATION_ATTACHMENT_FILE_BYTES,
  MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES,
  prepareConversationAttachments,
  persistConversationAttachments,
  validateImageAttachments,
} from './conversationFileAttachments';

describe('conversationFileAttachments', () => {
  it('keeps the picker formats aligned with supported code and text files', () => {
    expect(CONVERSATION_ATTACHMENT_ACCEPT).toContain('.tsx');
    expect(CONVERSATION_ATTACHMENT_ACCEPT).toContain('.toml');
    expect(CONVERSATION_ATTACHMENT_ACCEPT).toContain('application/json');
  });

  it('rejects an oversized file before reading any content', async () => {
    let sliceCalls = 0;
    const file = {
      name: 'huge.md',
      type: 'text/markdown',
      size: MAX_CONVERSATION_ATTACHMENT_FILE_BYTES + 1,
      slice: () => {
        sliceCalls += 1;
        return new Blob();
      },
    } as File;

    await expect(prepareConversationAttachments([file])).rejects.toMatchObject({
      code: 'file_too_large',
      fileName: 'huge.md',
    });
    expect(sliceCalls).toBe(0);
  });

  it('rejects the cumulative quota before reading selected files', async () => {
    let sliceCalls = 0;
    const file = {
      name: 'remaining.txt',
      type: 'text/plain',
      size: 32,
      slice: () => {
        sliceCalls += 1;
        return new Blob();
      },
    } as File;

    await expect(prepareConversationAttachments([file], {
      existingBytes: MAX_CONVERSATION_ATTACHMENT_TOTAL_BYTES - 16,
    })).rejects.toMatchObject({ code: 'total_too_large' });
    expect(sliceCalls).toBe(0);
  });

  it('rejects binary content after sampling and before reading the complete file', async () => {
    let fullReadStarted = false;
    const binarySample = new Blob(['prefix\0binary']);
    const file = {
      name: 'disguised.txt',
      type: 'text/plain',
      size: 128,
      slice: () => binarySample,
    } as File;
    Object.defineProperty(file, Symbol.toStringTag, { value: 'File' });
    Object.defineProperty(file, 'arrayBuffer', {
      value: () => {
        fullReadStarted = true;
        return Promise.resolve(new ArrayBuffer(0));
      },
    });

    await expect(prepareConversationAttachments([file])).rejects.toMatchObject({ code: 'binary_content' });
    expect(fullReadStarted).toBe(false);
  });

  it('reads every complete file only after the whole batch passes sampling', async () => {
    const prepared = await prepareConversationAttachments([
      new File(['# Notes\nMacro'], 'notes.md', { type: 'text/markdown' }),
      new File(['export const ok = true;'], 'sample.ts', { type: 'text/typescript' }),
    ]);

    expect(prepared.map((attachment) => attachment.fileName)).toEqual(['notes.md', 'sample.ts']);
    expect(prepared[0]?.content).toBe('# Notes\nMacro');
    expect(prepared[1]?.content).toBe('export const ok = true;');
  });

  it('accepts UTF-8 characters split across the sample boundary and rejects later binary data', async () => {
    const content = 'a'.repeat(8191) + 'é';
    expect((await prepareConversationAttachments([new File([content], 'utf8.txt')]))[0]?.content).toBe(content);
    await expect(prepareConversationAttachments([
      new File(['a'.repeat(8192) + '\0'], 'late-binary.txt'),
    ])).rejects.toMatchObject({ code: 'binary_content' });
  });

  it('reports exactly the files persisted before a storage failure and stops the batch', async () => {
    const prepared = await prepareConversationAttachments(['one.txt', 'two.txt', 'three.txt'].map(
      (name) => new File(['content'], name),
    ));
    const attempted: string[] = [];
    await expect(persistConversationAttachments(prepared, 'conversation', async (citation) => {
      attempted.push(citation.title);
      if (citation.title === 'two.txt') throw new Error('disk full');
      return citation.title;
    })).rejects.toMatchObject({ savedNames: ['one.txt'], failedName: 'two.txt' });
    expect(attempted).toEqual(['one.txt', 'two.txt']);
  });

  it('rejects image type spoofing and quotas before full image reads', async () => {
    await expect(validateImageAttachments([new File(['not a png'], 'test.png', { type: 'image/png' })], 0, 0))
      .rejects.toBeInstanceOf(ConversationAttachmentError);
    await expect(validateImageAttachments([new File([], 'test.png', { type: 'image/png' })], 10, 0))
      .rejects.toMatchObject({ code: 'too_many_files' });
  });
});
