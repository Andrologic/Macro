import {
  createToolCursor,
  paginateReadContent,
  paginateTextBytes,
  TOOL_OUTPUT_LIMITS,
} from "../shared/toolOutputLimits";

export interface ConversationFilePageInput {
  label: string;
  source: "WORKSPACE" | "CONTEXT_SNIPPET";
  content: string;
  args: Record<string, unknown>;
  language?: string | null;
  notice?: string | null;
}

const contentFingerprint = (content: string): string =>
  createToolCursor(content, 0).split(":")[1] ?? "unavailable";

export const formatConversationFilePage = (
  input: ConversationFilePageInput,
): string => {
  const fingerprint = contentFingerprint(input.content);
  if (input.args.raw === true) {
    const page = paginateTextBytes(
      input.content,
      input.args,
      `read_file_raw\0${input.label}\0${fingerprint}`,
    );
    const headers = [
      `FILE: ${input.label}`,
      `SOURCE: ${input.source}`,
      input.language ? `LANGUAGE: ${input.language}` : null,
      "MODE: RAW_UTF8",
      `CONTENT_FINGERPRINT: ${fingerprint}`,
      `BYTES: ${page.startByte}-${page.endByte}`,
      `TOTAL_BYTES: ${page.totalBytes}`,
      `RETURNED_BYTES: ${page.returnedBytes}`,
      `TRUNCATED: ${page.truncated}`,
      `NEXT_CURSOR: ${page.nextCursor ?? "none"}`,
      `LIMITS: max_bytes=${page.maxBytes}`,
      input.notice?.trim() || null,
    ].filter((line): line is string => Boolean(line));
    return `${headers.join("\n")}\n\n---BEGIN RAW CONTENT---\n${page.content}\n---END RAW CONTENT---`;
  }
  const endLineScope =
    typeof input.args.end_line === "number" && Number.isFinite(input.args.end_line)
      ? Math.floor(input.args.end_line)
      : "end";
  const page = paginateReadContent(
    input.content,
    input.args,
    `read_file\0${input.label}\0${fingerprint}\0${endLineScope}`,
  );
  const numberedContent = page.lines
    .map((line, index) => `${page.startLine + index}: ${line}`)
    .join("\n");
  const headers = [
    `FILE: ${input.label}`,
    `SOURCE: ${input.source}`,
    input.language ? `LANGUAGE: ${input.language}` : null,
    `CONTENT_FINGERPRINT: ${fingerprint}`,
    `LINES: ${page.startLine}-${page.endLine}`,
    `TOTAL_LINES: ${page.totalLines}`,
    `RETURNED_LINES: ${page.returnedLines}`,
    `TRUNCATED: ${page.truncated}`,
    `NEXT_CURSOR: ${page.nextCursor ?? "none"}`,
    `LIMITS: max_lines=${page.maxLines}, max_bytes=${page.maxBytes}, max_columns=${TOOL_OUTPUT_LIMITS.read.maxColumns}`,
    `COLUMN_TRUNCATED_LINES: ${page.columnTruncatedLines}`,
    input.notice?.trim() || null,
  ].filter((line): line is string => Boolean(line));

  return `${headers.join("\n")}\n\n---BEGIN FILE CONTENT---\n${numberedContent}\n---END FILE CONTENT---`;
};
