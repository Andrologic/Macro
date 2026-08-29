const COMBINING_MARKS = /\p{Mark}+/gu;

export const normalizeLocalSearchText = (value: string): string =>
  value
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase();

export const matchesLocalSearchQuery = (
  query: string,
  values: Array<string | null | undefined>,
): boolean => {
  const normalizedQuery = normalizeLocalSearchText(query.trim());
  if (!normalizedQuery) {
    return true;
  }

  return values.some((value) =>
    typeof value === 'string' && normalizeLocalSearchText(value).includes(normalizedQuery)
  );
};
