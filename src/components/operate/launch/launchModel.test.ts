import { expect, it } from "bun:test";
import type { TFunction } from "i18next";
import { classifyBlocker, failureCode, failureText, isFolderFailure, isRecheckFailure } from "./launchModel";

const t = ((key: string) => key) as unknown as TFunction;

it.each([
  [{ code: "modelUnavailable", subject: "reviewer" }, { kind: "model", agent: "reviewer" }],
  [{ code: "workingFolderRequired", subject: "" }, { kind: "folder" }],
  [{ code: "codexUnavailable", subject: "CODEX_LOGIN_REQUIRED" }, { kind: "codexGuide", textKey: "codexLoginRequired" }],
  [{ code: "codexUnavailable", subject: "CODEX_AUTH_VERSION_UNQUALIFIED" }, { kind: "codexGuide", textKey: "codexAuthVersionUnqualified" }],
  [{ code: "codexUnavailable", subject: "CODEX_NOT_FOUND" }, { kind: "codexConnect" }],
  [{ code: "mcpWorkspaceRequired", subject: "github" }, { kind: "author", textKey: "mcpWorkspaceRequired", subject: "github" }],
  [{ code: "unsupportedHarness", subject: "worker" }, { kind: "author", textKey: "unsupportedHarness" }],
  [{ code: "somethingNew", subject: "x" }, { kind: "author", textKey: "unknown" }],
])("classifies %j", (blocker, expected) => {
  expect(classifyBlocker(blocker)).toMatchObject(expected);
});

it("keeps the raw code and subject as technical detail only", () => {
  const view = classifyBlocker({ code: "mcpIsolationUnavailable", subject: "github" });
  expect(view.kind === "author" && view.technical).toBe("mcpIsolationUnavailable · github");
});

it("separates failures that call for a new check from those that do not", () => {
  for (const code of ["WORKING_FOLDER_IN_USE", "CONSENT_REQUIRED", "MODEL_UNAVAILABLE", "CODEX_LOGIN_REQUIRED"]) expect(isRecheckFailure(code)).toBe(true);
  expect(isRecheckFailure("ENGINE_DOWN")).toBe(false);
  expect(isFolderFailure("WORKING_FOLDER_CHANGED")).toBe(true);
  expect(isFolderFailure("CONSENT_REQUIRED")).toBe(false);
  expect(failureCode({ code: 4 })).toBe("");
  expect(failureCode(null)).toBe("");
});

it("words a failure plainly and keeps its code for the details", () => {
  expect(failureText({ code: "ENGINE_DOWN" }, t)).toEqual({ message: "agsdl.launch.failed", technical: "ENGINE_DOWN" });
  expect(failureText({ code: "ARCHIVE_INTEGRITY" }, t).message).toBe("agsdl.launch.invalidArchive");
});
