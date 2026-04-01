import type { AIChoice } from '../types';

const QUICK_REPLY_BLOCK_PATTERN = /\[quick-replies\]([\s\S]*?)\[\/quick-replies\]/i;

export interface ParsedQuickReplies {
  content: string;
  choices?: AIChoice[];
  allowFreeResponse?: boolean;
  requiresUserReply: boolean;
}

export const parseMessageQuickReplies = (content: string): ParsedQuickReplies => {
  const match = content.match(QUICK_REPLY_BLOCK_PATTERN);
  if (!match) {
    return {
      content,
      requiresUserReply: false,
    };
  }

  const options = match[1]
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('- '))
    .map((line) => line.slice(2).trim())
    .filter((line) => line.length > 0);

  const cleanedContent = content
    .replace(QUICK_REPLY_BLOCK_PATTERN, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (options.length !== 3) {
    return {
      content: cleanedContent,
      requiresUserReply: false,
    };
  }

  return {
    content: cleanedContent,
    choices: options.map((text, index) => ({
      id: `choice-${index + 1}`,
      text,
    })),
    allowFreeResponse: true,
    requiresUserReply: true,
  };
};
