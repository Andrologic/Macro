import type { AppMode } from '../../../types';

export type SlashContextCandidateKind = 'need' | 'skill' | 'file';

export interface SlashContextRankCandidate {
  key: string;
  kind: SlashContextCandidateKind;
  title: string;
  searchText: string;
  disabled?: boolean;
  skillEnabled?: boolean;
  isFocusedFile?: boolean;
  useCount?: number;
  lastUsedAt?: number;
}

export interface SlashContextRankOptions {
  query: string;
  mode: AppMode;
  hasActivePlan: boolean;
  now?: number;
}

const normalize = (value: string): string =>
  value
    .trim()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase();

const getBasename = (value: string): string => {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || normalized;
};

export const hasFileQueryIntent = (query: string): boolean =>
  /[/.]/.test(query) || /\.[A-Za-z0-9]{1,8}$/.test(query.trim());

const fuzzyMatch = (query: string, haystack: string): boolean => {
  if (!query) return false;
  let index = 0;
  for (const char of haystack) {
    if (char === query[index]) {
      index += 1;
      if (index === query.length) return true;
    }
  }
  return false;
};

const scoreTextMatch = (query: string, candidate: SlashContextRankCandidate): number => {
  if (!query) return 0;
  const title = normalize(candidate.title);
  const basename = normalize(getBasename(candidate.title));
  const searchText = normalize(candidate.searchText);
  const segments = searchText.split(/[/\s._-]+/).filter(Boolean);

  if (title === query || basename === query) return 80;
  if (title.startsWith(query) || basename.startsWith(query)) return 55;
  if (segments.some((segment) => segment.startsWith(query))) return 40;
  if (searchText.includes(query) || fuzzyMatch(query, title) || fuzzyMatch(query, basename)) {
    return 15;
  }
  return Number.NEGATIVE_INFINITY;
};

const scoreUsage = (
  candidate: SlashContextRankCandidate,
  now: number,
): number => {
  const useCount = candidate.useCount ?? 0;
  const frequency = Math.min(20, Math.log2(useCount + 1) * 5);
  const lastUsedAt = candidate.lastUsedAt ?? 0;
  if (!lastUsedAt) return frequency;

  const ageMs = Math.max(0, now - lastUsedAt);
  const ageDays = ageMs / 86_400_000;
  const recency = Math.max(0, 12 - ageDays * 2);
  return frequency + recency;
};

export const scoreSlashContextCandidate = (
  candidate: SlashContextRankCandidate,
  options: SlashContextRankOptions,
): number => {
  const query = normalize(options.query);
  const textScore = scoreTextMatch(query, candidate);
  if (query && textScore === Number.NEGATIVE_INFINITY) {
    return textScore;
  }

  let score = textScore;
  const fileIntent = hasFileQueryIntent(options.query);
  if (candidate.kind === 'file') {
    score += fileIntent ? 35 : 0;
    score += candidate.isFocusedFile ? 20 : 8;
  }
  if (
    candidate.kind === 'need' &&
    options.mode === 'Architect' &&
    options.hasActivePlan &&
    !fileIntent
  ) {
    score += 15;
  }
  if (candidate.kind === 'skill' && candidate.skillEnabled) {
    score += 10;
  }
  if (
    candidate.kind === 'skill' &&
    candidate.skillEnabled &&
    candidate.lastUsedAt &&
    (options.now ?? Date.now()) - candidate.lastUsedAt < 7 * 86_400_000
  ) {
    score += 4;
  }
  if (candidate.disabled) {
    score -= 60;
  }

  score += scoreUsage(candidate, options.now ?? Date.now());
  return score;
};

export const rankSlashContextCandidates = <T extends SlashContextRankCandidate>(
  candidates: T[],
  options: SlashContextRankOptions,
): Array<T & { score: number }> =>
  candidates
    .map((candidate) => ({
      ...candidate,
      score: scoreSlashContextCandidate(candidate, options),
    }))
    .filter((candidate) => candidate.score !== Number.NEGATIVE_INFINITY)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (Boolean(left.disabled) !== Boolean(right.disabled)) return left.disabled ? 1 : -1;
      return left.title.localeCompare(right.title);
    });
