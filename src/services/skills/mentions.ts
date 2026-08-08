import { normalizeSkillLookupName } from './identity';

const DOLLAR_MENTION_PATTERN = /\$([-\p{Letter}\p{Number}_:]{1,120})/gu;
const BRACKET_MENTION_PATTERN = /\[skill:\s*([^\]]+)\]/giu;

export const parseMentionNames = (content: string): string[] => {
  const dollarMentions = Array.from(content.matchAll(DOLLAR_MENTION_PATTERN))
    .map((match) => match[1])
    .filter((value): value is string => Boolean(value));
  const bracketMentions = Array.from(content.matchAll(BRACKET_MENTION_PATTERN))
    .map((match) => match[1]?.trim())
    .filter((value): value is string => Boolean(value));
  return [...dollarMentions, ...bracketMentions];
};

export const normalizeSkillMentionName = normalizeSkillLookupName;
