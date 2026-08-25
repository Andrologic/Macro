import type { ConversationGoalVerdict } from "../../types";

export interface GoalVerdictValidationIssue {
  path: string;
  message: string;
}

export type GoalVerdictValidationResult =
  | { ok: true; value: ConversationGoalVerdict }
  | { ok: false; issues: GoalVerdictValidationIssue[] };

const VERDICT_KEYS = [
  "verdict",
  "summary",
  "criteria",
  "feedback",
  "questionForUser",
  "confidence",
] as const;
const CRITERION_KEYS = ["criterion", "status", "evidence"] as const;
const EVIDENCE_KEYS = ["source", "finding"] as const;
const VERDICTS = new Set(["continue", "achieved", "needs_user", "cannot_progress"]);
const CRITERION_STATUSES = new Set(["met", "unmet", "uncertain"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

const normalizeText = (value: string): string => value.trim().replace(/\s+/g, " ");

const hasExactKeys = (
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
  issues: GoalVerdictValidationIssue[],
): boolean => {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length === wanted.length && actual.every((key, index) => key === wanted[index])) {
    return true;
  }
  issues.push({
    path,
    message: `Expected exactly these keys: ${wanted.join(", ")}.`,
  });
  return false;
};
const readRequiredText = (
  value: unknown,
  path: string,
  issues: GoalVerdictValidationIssue[],
): string | null => {
  if (typeof value !== "string" || !normalizeText(value)) {
    issues.push({ path, message: "Expected a non-empty string." });
    return null;
  }
  return normalizeText(value);
};

export const validateConversationGoalVerdict = (
  value: unknown,
  expectedCriteria: readonly string[],
): GoalVerdictValidationResult => {
  const issues: GoalVerdictValidationIssue[] = [];
  if (!isRecord(value)) {
    return { ok: false, issues: [{ path: "$", message: "Expected a JSON object." }] };
  }
  hasExactKeys(value, VERDICT_KEYS, "$", issues);

  const verdict =
    typeof value.verdict === "string" && VERDICTS.has(value.verdict)
      ? value.verdict as ConversationGoalVerdict["verdict"]
      : null;
  if (!verdict) {
    issues.push({ path: "$.verdict", message: "Unknown goal verdict." });
  }
  const summary = readRequiredText(value.summary, "$.summary", issues);
  const feedback =
    typeof value.feedback === "string" ? normalizeText(value.feedback) : null;
  if (feedback === null) {
    issues.push({ path: "$.feedback", message: "Expected a string." });
  }

  const confidence = value.confidence;
  if (
    typeof confidence !== "number" ||
    !Number.isFinite(confidence) ||
    confidence < 0 ||
    confidence > 1
  ) {
    issues.push({ path: "$.confidence", message: "Expected a finite number between 0 and 1." });
  }

  let questionForUser: string | null = null;
  if (value.questionForUser !== null) {
    questionForUser = readRequiredText(value.questionForUser, "$.questionForUser", issues);
  }
  if (verdict === "needs_user" && !questionForUser) {
    issues.push({
      path: "$.questionForUser",
      message: "A needs_user verdict requires a question.",
    });
  } else if (verdict && verdict !== "needs_user" && value.questionForUser !== null) {
    issues.push({
      path: "$.questionForUser",
      message: "Only needs_user may include a question.",
    });
  }

  const normalizedExpectedCriteria = expectedCriteria.map(normalizeText);
  const criteria: ConversationGoalVerdict["criteria"] = [];
  if (!Array.isArray(value.criteria)) {
    issues.push({ path: "$.criteria", message: "Expected an array." });
  } else {
    if (value.criteria.length !== normalizedExpectedCriteria.length) {
      issues.push({
        path: "$.criteria",
        message: `Expected ${normalizedExpectedCriteria.length} criterion result(s).`,
      });
    }
    value.criteria.forEach((candidate, criterionIndex) => {
      const criterionPath = `$.criteria[${criterionIndex}]`;
      if (!isRecord(candidate)) {
        issues.push({ path: criterionPath, message: "Expected an object." });
        return;
      }
      hasExactKeys(candidate, CRITERION_KEYS, criterionPath, issues);
      const criterion = readRequiredText(candidate.criterion, `${criterionPath}.criterion`, issues);
      const expectedCriterion = normalizedExpectedCriteria[criterionIndex];
      if (criterion && criterion !== expectedCriterion) {
        issues.push({
          path: `${criterionPath}.criterion`,
          message: "Criterion does not match the requested success criterion at this position.",
        });
      }
      const status =
        typeof candidate.status === "string" && CRITERION_STATUSES.has(candidate.status)
          ? candidate.status as ConversationGoalVerdict["criteria"][number]["status"]
          : null;
      if (!status) {
        issues.push({ path: `${criterionPath}.status`, message: "Unknown criterion status." });
      }

      const evidence: ConversationGoalVerdict["criteria"][number]["evidence"] = [];
      if (!Array.isArray(candidate.evidence) || candidate.evidence.length === 0) {
        issues.push({
          path: `${criterionPath}.evidence`,
          message: "Expected at least one evidence item.",
        });
      } else {
        const seenEvidence = new Set<string>();
        candidate.evidence.forEach((item, evidenceIndex) => {
          const evidencePath = `${criterionPath}.evidence[${evidenceIndex}]`;
          if (!isRecord(item)) {
            issues.push({ path: evidencePath, message: "Expected an object." });
            return;
          }
          hasExactKeys(item, EVIDENCE_KEYS, evidencePath, issues);
          const source = readRequiredText(item.source, `${evidencePath}.source`, issues);
          const finding = readRequiredText(item.finding, `${evidencePath}.finding`, issues);
          if (!source || !finding) return;
          const key = `${source}\u0000${finding}`;
          if (seenEvidence.has(key)) {
            issues.push({ path: evidencePath, message: "Duplicate evidence item." });
            return;
          }
          seenEvidence.add(key);
          evidence.push({ source, finding });
        });
      }
      if (criterion && status) criteria.push({ criterion, status, evidence });
    });
  }

  if (verdict === "achieved" && criteria.some((criterion) => criterion.status !== "met")) {
    issues.push({
      path: "$.verdict",
      message: "An achieved verdict requires every criterion to be met.",
    });
  }
  if (verdict !== "achieved" && feedback !== null && !feedback) {
    issues.push({
      path: "$.feedback",
      message: "A non-achieved verdict requires executor feedback.",
    });
  }

  if (
    issues.length > 0 ||
    !verdict ||
    !summary ||
    feedback === null ||
    typeof confidence !== "number"
  ) {
    return { ok: false, issues };
  }
  return {
    ok: true,
    value: {
      verdict,
      summary,
      criteria,
      feedback,
      questionForUser,
      confidence,
    },
  };
};

export const parseConversationGoalVerdict = (
  json: string,
  expectedCriteria: readonly string[],
): GoalVerdictValidationResult => {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return {
      ok: false,
      issues: [
        {
          path: "$",
          message: error instanceof Error ? `Invalid JSON: ${error.message}` : "Invalid JSON.",
        },
      ],
    };
  }
  return validateConversationGoalVerdict(value, expectedCriteria);
};
