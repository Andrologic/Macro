export type TextInsertionSpacing = 'preserve' | 'contextual';

interface ContextualInsertionInput {
  text: string;
  before: string;
  after: string;
}

const STARTS_WITH_CLOSING_PUNCTUATION = /^[,.;:!?%)\]}]/u;
const ENDS_WITH_OPENING_PUNCTUATION = /[([{]$/u;
const ENDS_WITH_WHITESPACE = /\s$/u;
const STARTS_WITH_WHITESPACE = /^\s/u;

export const prepareContextualTextInsertion = ({
  text,
  before,
  after,
}: ContextualInsertionInput): string => {
  const normalized = text.trim();
  if (!normalized) return '';

  const needsLeadingSpace =
    Boolean(before) &&
    !ENDS_WITH_WHITESPACE.test(before) &&
    !ENDS_WITH_OPENING_PUNCTUATION.test(before) &&
    !STARTS_WITH_CLOSING_PUNCTUATION.test(normalized);
  const needsTrailingSpace =
    Boolean(after) &&
    !STARTS_WITH_WHITESPACE.test(after) &&
    !ENDS_WITH_OPENING_PUNCTUATION.test(normalized) &&
    !STARTS_WITH_CLOSING_PUNCTUATION.test(after);

  return `${needsLeadingSpace ? ' ' : ''}${normalized}${needsTrailingSpace ? ' ' : ''}`;
};
