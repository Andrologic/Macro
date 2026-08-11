import fs from "node:fs";
import path from "node:path";

const root = process.cwd();
const languageModulePath = path.join(root, "src", "i18n", "languages.ts");
const localeDir = path.join(root, "src", "i18n", "locales");
const sourceDirs = [
  path.join(root, "src", "components"),
  path.join(root, "src", "hooks"),
  path.join(root, "src", "services"),
  path.join(root, "src", "stores"),
  path.join(root, "src-tauri", "src"),
];
const uiStringAuditFiles = [
  "src/components/ai/ModelDropdown.tsx",
  "src/components/ai/ProviderDropdown.tsx",
  "src/components/chat/ContextToolbox.tsx",
  "src/components/editor/LiveCodePreview.tsx",
  "src/components/git/GitGraph.tsx",
  "src/components/implement/FileChangesPanel.tsx",
  "src/components/layout/LeftPanel.tsx",
  "src/components/layout/Footer.tsx",
  "src/components/layout/WindowControls.tsx",
  "src/components/modals/FileChangesDiffModal.tsx",
  "src/components/modals/ImagePreviewModal.tsx",
  "src/components/modals/ProjectModal.tsx",
  "src/components/modals/ProjectNavigator.tsx",
  "src/components/plan/PlanReviewModal.tsx",
  "src/components/project/TaskListView.tsx",
  "src/components/settings/views/GeneralView.tsx",
  "src/components/settings/views/ShortcutsView.tsx",
  "src/components/settings/views/ToolsView.tsx",
  "src/components/settings/views/ai/ModelsSettings.tsx",
  "src/components/settings/views/ai/ProvidersSettings.tsx",
  "src/components/tasks/TaskQueue.tsx",
  "src/components/ui/GroupCombobox.tsx",
  "src/components/ui/SearchBar.tsx",
];
const allowedUiLiteralPatterns = [
  /Promise(?:<|\b)/,
  /placeholder="tvly-[^"]+"/,
  /placeholder="BSA[^"]+"/,
  /placeholder="sk-[^"]+"/,
  /placeholder="https:\/\/[^"]+"/,
  /value="(?:openai|anthropic|gemini|ollama|lmstudio|openrouter)"/,
];

const flattenObject = (value, prefix = "") => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value).flatMap(([key, nestedValue]) => {
    const next = prefix ? `${prefix}.${key}` : key;
    if (nestedValue && typeof nestedValue === "object" && !Array.isArray(nestedValue)) {
      return flattenObject(nestedValue, next);
    }
    return [[next, String(nestedValue)]];
  });
};

const readSupportedLanguages = () => {
  const content = fs.readFileSync(languageModulePath, "utf8");
  return [...content.matchAll(/code:\s*"([a-z]{2})"/g)].map((match) => match[1]);
};

const readJson = (filePath) => JSON.parse(fs.readFileSync(filePath, "utf8"));

const readLocale = (language) => {
  const basePath = path.join(localeDir, `${language}.json`);
  const locale = readJson(basePath);
  const implementSegmentPath = path.join(localeDir, "segments", `implement-${language}.json`);

  if (fs.existsSync(implementSegmentPath)) {
    locale.implement = readJson(implementSegmentPath);
  }

  return locale;
};

const extractPlaceholders = (value) =>
  [...value.matchAll(/\{\{\s*([^}]+?)\s*\}\}/g)].map((match) => match[1].trim()).sort();

const walkFiles = (dir) => {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return walkFiles(fullPath);
    }
    return fullPath;
  });
};

const supportedLanguages = readSupportedLanguages();
const englishLocale = readLocale("en");
const englishEntries = flattenObject(englishLocale);
const englishKeys = new Map(englishEntries);
const frenchKeys = new Map(flattenObject(readLocale("fr")));

const localeErrors = [];
const copiedFrenchErrors = [];
const translationKeyErrors = [];

for (const language of supportedLanguages) {
  const filePath = path.join(localeDir, `${language}.json`);
  if (!fs.existsSync(filePath)) {
    localeErrors.push(`Missing locale file: ${path.relative(root, filePath)}`);
    continue;
  }

  const localeEntries = new Map(flattenObject(readLocale(language)));
  const missingKeys = [...englishKeys.keys()].filter((key) => !localeEntries.has(key));
  const extraKeys = [...localeEntries.keys()].filter((key) => !englishKeys.has(key));

  if (missingKeys.length > 0) {
    localeErrors.push(
      `${language}.json is missing keys:\n${missingKeys.map((key) => `  - ${key}`).join("\n")}`
    );
  }

  if (extraKeys.length > 0) {
    localeErrors.push(
      `${language}.json has extra keys:\n${extraKeys.map((key) => `  - ${key}`).join("\n")}`
    );
  }

  for (const [key, englishValue] of englishEntries) {
    const localizedValue = localeEntries.get(key);
    if (typeof localizedValue !== "string") {
      continue;
    }

    const englishPlaceholders = extractPlaceholders(englishValue);
    const localizedPlaceholders = extractPlaceholders(localizedValue);
    if (englishPlaceholders.join("|") !== localizedPlaceholders.join("|")) {
      localeErrors.push(
        `${language}.json placeholder mismatch for ${key}: expected [${englishPlaceholders.join(", ")}], got [${localizedPlaceholders.join(", ")}]`
      );
    }

    const frenchValue = frenchKeys.get(key);
    if (
      language !== "fr" &&
      localizedValue === frenchValue &&
      /[àâçéèêëîïôùûüÿœ]/i.test(localizedValue)
    ) {
      copiedFrenchErrors.push(
        `${language}.json appears to copy French for ${key}: ${JSON.stringify(localizedValue)}`
      );
    }
  }
}

const localePatternErrors = [];
const localePatterns = [
  /toLocaleDateString\(\s*["'][a-z]{2}(?:-[A-Z]{2})?["']/g,
  /toLocaleString\(\s*["'][a-z]{2}(?:-[A-Z]{2})?["']/g,
  /localeCompare\([^)]*["'][a-z]{2}(?:-[A-Z]{2})?["']/g,
  /new Intl\.(?:DateTimeFormat|NumberFormat|RelativeTimeFormat)\(\s*["'][a-z]{2}(?:-[A-Z]{2})?["']/g,
];

for (const dir of sourceDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const file of walkFiles(dir).filter((filePath) => /\.(ts|tsx|rs)$/.test(filePath))) {
    const content = fs.readFileSync(file, "utf8");
    for (const pattern of localePatterns) {
      const matches = content.match(pattern);
      if (!matches) continue;
      localePatternErrors.push(
        `${path.relative(root, file)} contains hard-coded locale usage:\n${matches
          .map((match) => `  - ${match}`)
          .join("\n")}`
      );
    }
  }
}

const translationKeyPattern = /\bt\(\s*['"]([^'"`]+)['"]/g;

for (const dir of sourceDirs) {
  if (!fs.existsSync(dir)) continue;
  for (const file of walkFiles(dir).filter((filePath) => /\.(ts|tsx)$/.test(filePath))) {
    const content = fs.readFileSync(file, "utf8");
    const seenKeys = new Set();
    for (const match of content.matchAll(translationKeyPattern)) {
      const key = match[1];
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      const hasPluralVariant =
        englishKeys.has(`${key}_one`) ||
        englishKeys.has(`${key}_other`);
      if (!englishKeys.has(key) && !hasPluralVariant) {
        translationKeyErrors.push(
          `${path.relative(root, file)} references missing i18n key: ${key}`
        );
      }
    }
  }
}

const uiLiteralErrors = [];
const uiLiteralPatterns = [
  /\b(?:title|placeholder|aria-label)=["']([A-Za-z][^"']{2,})["']/g,
  />\s*([A-Za-z][^<{]{2,})\s*</g,
];

for (const relativeFile of uiStringAuditFiles) {
  const filePath = path.join(root, relativeFile);
  if (!fs.existsSync(filePath)) continue;
  const content = fs.readFileSync(filePath, "utf8");
  const lines = content.split(/\r?\n/);

  lines.forEach((line, index) => {
    for (const pattern of uiLiteralPatterns) {
      const matches = [...line.matchAll(pattern)];
      for (const match of matches) {
        const literal = match[1]?.trim();
        if (!literal) continue;
        if (allowedUiLiteralPatterns.some((allowed) => allowed.test(line))) continue;
        if (literal.startsWith("{") || literal.startsWith("http")) continue;
        uiLiteralErrors.push(
          `${relativeFile}:${index + 1} contains a hard-coded UI literal: ${literal}`
        );
      }
    }
  });
}

const errors = [
  ...localeErrors,
  ...copiedFrenchErrors,
  ...translationKeyErrors,
  ...localePatternErrors,
  ...uiLiteralErrors,
];

if (errors.length > 0) {
  console.error("i18n audit failed:\n");
  console.error(errors.join("\n\n"));
  process.exit(1);
}

console.log(`i18n audit passed for languages: ${supportedLanguages.join(", ")}`);
