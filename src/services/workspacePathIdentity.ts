type CanonicalWorkspacePath = {
  normalized: string;
  comparisonKey: string;
  prefixKey: string;
  segments: string[];
  escapedAboveRoot: boolean;
};

export const canonicalizeWorkspacePath = (value: string): CanonicalWorkspacePath => {
  let input = value.trim().replace(/\\/g, "/");
  if (/^\/\/\?\/UNC\//i.test(input)) {
    input = `//${input.slice(8)}`;
  } else if (/^\/\/\?\/[a-z]:\//i.test(input)) {
    input = input.slice(4);
  }

  const isUnc = input.startsWith("//");
  const driveMatch = input.match(/^([a-z]:)(?:\/|$)/i);
  const isAbsolutePosix = !isUnc && !driveMatch && input.startsWith("/");
  const rawSegments = input.split("/").filter(Boolean);
  let prefix = "";
  let pathSegments = rawSegments;

  if (isUnc) {
    const server = rawSegments[0] ?? "";
    const share = rawSegments[1] ?? "";
    prefix = `//${server}/${share}`;
    pathSegments = rawSegments.slice(2);
  } else if (driveMatch) {
    prefix = driveMatch[1];
    pathSegments = rawSegments.slice(1);
  } else if (isAbsolutePosix) {
    prefix = "/";
  }

  const segments: string[] = [];
  let escapedAboveRoot = false;
  for (const segment of pathSegments) {
    if (segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments[segments.length - 1] !== "..") {
        segments.pop();
      } else if (prefix) {
        escapedAboveRoot = true;
      } else {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }

  const normalized = prefix === "/"
    ? `/${segments.join("/")}`
    : prefix
      ? `${prefix}${segments.length > 0 ? `/${segments.join("/")}` : ""}`
      : segments.join("/") || ".";
  const caseInsensitive = Boolean(driveMatch || isUnc);
  const comparisonKey = caseInsensitive ? normalized.toLowerCase() : normalized;
  const prefixKey = caseInsensitive ? prefix.toLowerCase() : prefix;
  return { normalized, comparisonKey, prefixKey, segments, escapedAboveRoot };
};

export const relativePathWithinRoot = (path: string, root: string): string | null => {
  const normalizedPath = canonicalizeWorkspacePath(path);
  const normalizedRoot = canonicalizeWorkspacePath(root);
  if (
    normalizedPath.escapedAboveRoot ||
    normalizedRoot.escapedAboveRoot ||
    normalizedPath.prefixKey !== normalizedRoot.prefixKey
  ) {
    return null;
  }
  const caseInsensitive = Boolean(normalizedRoot.prefixKey.match(/^(?:[a-z]:|\/\/)/i));
  const pathSegments = caseInsensitive
    ? normalizedPath.segments.map((segment) => segment.toLowerCase())
    : normalizedPath.segments;
  const rootSegments = caseInsensitive
    ? normalizedRoot.segments.map((segment) => segment.toLowerCase())
    : normalizedRoot.segments;
  if (
    rootSegments.length > pathSegments.length ||
    rootSegments.some((segment, index) => pathSegments[index] !== segment)
  ) {
    return null;
  }
  return normalizedPath.segments.slice(rootSegments.length).join("/") || ".";
};
