import { expect, it } from "bun:test";
import type { TFunction } from "i18next";
import { classifyBlocker, failureCode, failureText, isFolderFailure, isRecheckFailure } from "./launchModel";

const t = ((key: string) => key) as unknown as TFunction;

it.each([
  [{ code: "modelUnavailable", subject: "reviewer" }, { kind: "model", agent: "reviewer" }],
  [{ code: "workingFolderRequired", subject: "" }, { kind: "folder" }],
  [{ code: "codexUnavailable", subject: "CODEX_LOGIN_REQUIRED" }, { kind: "codex", textKey: "codexLoginRequired", guide: "login" }],
  [{ code: "codexUnavailable", subject: "CODEX_AUTH_VERSION_UNQUALIFIED" }, { kind: "codex", textKey: "codexAuthVersionUnqualified", guide: "auth" }],
  [{ code: "codexUnavailable", subject: "CODEX_NOT_INSTALLED" }, { kind: "codex", textKey: "codexNotInstalled", guide: "install" }],
  [{ code: "codexUnavailable", subject: "CODEX_PACKAGE_INCOMPLETE" }, { kind: "codex", textKey: "codexPackageIncomplete", guide: "install" }],
  [{ code: "codexUnavailable", subject: "CODEX_VERSION_UNQUALIFIED", codexPlatform: "linuxArm64" as const }, { kind: "codex", textKey: "codexVersionLinux", guide: "install" }],
  [{ code: "codexUnavailable", subject: "CODEX_VERSION_UNQUALIFIED", codexPlatform: "unsupported" as const }, { kind: "codex", textKey: "codexPlatformUnqualified" }],
  [{ code: "codexUnavailable", subject: "CODEX_WRITE_PROFILE_UNQUALIFIED" }, { kind: "codex", textKey: "codexWriteProfileUnqualified", guide: "install" }],
  [{ code: "codexUnavailable", subject: "CODEX_SOMETHING_NEW" }, { kind: "codex", textKey: "codexUnavailable" }],
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
  for (const code of ["WORKING_FOLDER_IN_USE", "CONSENT_REQUIRED", "MODEL_UNAVAILABLE", "CODEX_LOGIN_REQUIRED", "CODEX_VERSION_UNQUALIFIED"]) expect(isRecheckFailure(code)).toBe(true);
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
