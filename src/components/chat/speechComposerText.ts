export interface SpeechComposerInsertion {
  start: number;
  end: number;
  rawText: string;
}

const commonPrefixLength = (left: string, right: string): number => {
  const limit = Math.min(left.length, right.length);
  let index = 0;
  while (index < limit && left[index] === right[index]) index += 1;
  return index;
};

export const locateSpeechComposerInsertion = (
  previousText: string,
  composedText: string,
  rawText: string,
): SpeechComposerInsertion | null => {
  if (!rawText) return null;
  const changedAt = commonPrefixLength(previousText, composedText);
  const start = composedText.indexOf(rawText, changedAt);
  const fallbackStart = start >= 0 ? start : composedText.lastIndexOf(rawText);
  if (fallbackStart < 0) return null;
  return {
    start: fallbackStart,
    end: fallbackStart + rawText.length,
    rawText,
  };
};

export const replaceSpeechComposerInsertion = (
  currentText: string,
  insertion: SpeechComposerInsertion,
  replacement: string,
): string | null => {
  if (currentText.slice(insertion.start, insertion.end) !== insertion.rawText) return null;
  return `${currentText.slice(0, insertion.start)}${replacement}${currentText.slice(insertion.end)}`;
};
