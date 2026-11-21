import type { StandaloneTaskKind } from "../../types";

const METADATA_MAX_TITLE_LENGTH = 72;
const METADATA_MAX_DESCRIPTION_LENGTH = 180;
const MANUAL_FEATURE_MAX_SLUG_LENGTH = 64;

export const getConversationFallbackTitle = (content: string): string => {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "New Conversation";
  const words = cleaned.split(" ").slice(0, 6).join(" ");
  return words.slice(0, METADATA_MAX_TITLE_LENGTH);
};

export const getConversationFallbackDescription = (content: string): string => {
  const cleaned = content.replace(/\s+/g, " ").trim();
  if (!cleaned) return "General discussion.";
  return cleaned.slice(0, METADATA_MAX_DESCRIPTION_LENGTH);
};

export const extractJsonObjectFromModelOutput = (
  raw: string,
): Record<string, unknown> => {
  const noThinking = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const firstBrace = noThinking.indexOf("{");
  const lastBrace = noThinking.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace <= firstBrace) {
    throw new Error("No JSON object found");
  }

  return JSON.parse(noThinking.slice(firstBrace, lastBrace + 1)) as Record<
    string,
    unknown
  >;
};

export const extractMetadataFromModelOutput = (
  raw: string,
): { title: string; description: string } => {
  const parsed = extractJsonObjectFromModelOutput(raw) as {
    title?: unknown;
    description?: unknown;
  };

  if (
    typeof parsed.title !== "string" ||
    typeof parsed.description !== "string"
  ) {
    throw new Error("Invalid metadata shape");
  }

  const title = parsed.title
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_TITLE_LENGTH);
  const description = parsed.description
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_DESCRIPTION_LENGTH);

  if (!title || !description) {
    throw new Error("Empty metadata values");
  }

  return { title, description };
};

export const normalizeManualFeatureSlugInput = (value: string): string => {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/^refs\/heads\//, "")
    .replace(/\\/g, "/")
    .replace(/\/+$/, "");
  const leaf = normalized.split("/").filter(Boolean).pop() || normalized;
  return (
    leaf
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^-+/, "")
      .replace(/-+$/, "")
      .slice(0, MANUAL_FEATURE_MAX_SLUG_LENGTH) || "work"
  );
};

export const extractManualFeatureMetadataFromModelOutput = (
  raw: string,
): {
  title: string;
  description: string;
  featureSlug: string;
  taskKind: StandaloneTaskKind;
} => {
  const parsed = extractJsonObjectFromModelOutput(raw) as {
    title?: unknown;
    description?: unknown;
    featureSlug?: unknown;
    taskKind?: unknown;
  };

  if (
    typeof parsed.title !== "string" ||
    typeof parsed.description !== "string" ||
    typeof parsed.featureSlug !== "string" ||
    (parsed.taskKind !== "feature" &&
      parsed.taskKind !== "bugfix" &&
      parsed.taskKind !== "hotfix" &&
      parsed.taskKind !== "direct")
  ) {
    throw new Error("Invalid manual feature metadata shape");
  }

  const title = parsed.title
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_TITLE_LENGTH);
  const description = parsed.description
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, METADATA_MAX_DESCRIPTION_LENGTH);
  const featureSlug = normalizeManualFeatureSlugInput(parsed.featureSlug);
  const taskKind = parsed.taskKind;

  if (!title || !description || !featureSlug) {
    throw new Error("Empty manual feature metadata values");
  }

  return { title, description, featureSlug, taskKind };
};

export const buildManualFeatureFallbackMetadata = (
  content: string,
  taskTitle = '',
): {
  title: string;
  description: string;
  featureSlug: string;
  taskKind: StandaloneTaskKind;
} => {
  const title = getConversationFallbackTitle(content);
  const description = getConversationFallbackDescription(content);
  const featureSlug = normalizeManualFeatureSlugInput(title || content);
  const normalizedContent = `${taskTitle} ${content}`.toLocaleLowerCase();
  const taskKind: StandaloneTaskKind =
    /\b(hotfix|production incident|incident de production|correctif urgent|urgence production)\b/.test(normalizedContent)
      ? "hotfix"
      : /\b(bug|bugfix|fix|réparer|corriger|correctif|erreur|régression|regression)\b/.test(normalizedContent)
        ? "bugfix"
        : "feature";
  return { title, description, featureSlug, taskKind };
};
