import type { TFunction } from "i18next";
import type { LaunchPreview } from "../../../services/ipc/architectLaunch";
import { reservedMcpSecretText } from "../../agsdl/errorText";

const codexGuide = "https://github.com/Andrologic/Macro/blob/main/docs/agsdl-codex-native.md";

export const codexGuides = {
  install: { href: codexGuide, label: "codexInstallGuide" },
  login: { href: codexGuide + "#private-login", label: "codexLoginGuide" },
  auth: { href: codexGuide + "#explicit-existing-file-authentication", label: "codexFileAuthGuide" },
} as const;

type CodexBlocker = { textKey: string; guide?: keyof typeof codexGuides };

const codexBlockers: Readonly<Record<string, CodexBlocker>> = {
  CODEX_NOT_INSTALLED: { textKey: "codexNotInstalled", guide: "install" },
  CODEX_NOT_FOUND: { textKey: "codexNotInstalled", guide: "install" },
  CODEX_PACKAGE_INCOMPLETE: { textKey: "codexPackageIncomplete", guide: "install" },
  CODEX_VERSION_UNQUALIFIED: { textKey: "codexVersionUnqualified", guide: "install" },
  CODEX_PLATFORM_UNQUALIFIED: { textKey: "codexPlatformUnqualified" },
  CODEX_CONTEXT_UNQUALIFIED: { textKey: "codexContextUnqualified", guide: "login" },
  CODEX_PROFILE_UNQUALIFIED: { textKey: "codexProfileUnqualified", guide: "login" },
  CODEX_WRITE_PROFILE_UNQUALIFIED: { textKey: "codexWriteProfileUnqualified", guide: "install" },
  CODEX_SANDBOX_UNQUALIFIED: { textKey: "codexSandboxUnqualified", guide: "install" },
  CODEX_LOGIN_REQUIRED: { textKey: "codexLoginRequired", guide: "login" },
  CODEX_ACCOUNT_UNQUALIFIED: { textKey: "codexAccountUnqualified", guide: "login" },
  CODEX_AUTH_VERSION_UNQUALIFIED: { textKey: "codexAuthVersionUnqualified", guide: "auth" },
  CODEX_AUTH_PROFILE_CONFLICT: { textKey: "codexAuthProfileConflict", guide: "auth" },
  CODEX_AUTH_SOURCE_UNAVAILABLE: { textKey: "codexAuthSourceUnavailable", guide: "auth" },
  CODEX_AUTH_SOURCE_UNSUPPORTED: { textKey: "codexAuthSourceUnsupported", guide: "auth" },
  CODEX_AUTH_EXPIRED: { textKey: "codexAuthExpired", guide: "auth" },
  CODEX_AUTH_REFRESH_REQUIRED: { textKey: "codexAuthRefreshRequired", guide: "auth" },
  CODEX_AUTH_ACCOUNT_CHANGED: { textKey: "codexAuthAccountChanged", guide: "auth" },
  CODEX_AUTH_FAILED: { textKey: "codexAuthFailed", guide: "auth" },
  CODEX_AUTH_TIMEOUT: { textKey: "codexAuthTimeout", guide: "auth" },
  CODEX_MODEL_UNQUALIFIED: { textKey: "codexModelUnqualified", guide: "install" },
  CODEX_REQUEST_FAILED: { textKey: "codexRequestFailed", guide: "install" },
  CODEX_RPC_SERVER_REQUEST_UNQUALIFIED: { textKey: "codexRpcUnqualified", guide: "install" },
  NATIVE_UNCERTAIN: { textKey: "codexProtocolFailed", guide: "install" },
  STOP_PENDING: { textKey: "codexStopPending" },
};

function codexBlocker(code: string, platform?: Blocker["codexPlatform"]): CodexBlocker {
  if (code === "CODEX_VERSION_UNQUALIFIED") {
    if (platform === "macosArm64") return { textKey: "codexVersionMac", guide: "install" };
    if (platform === "linuxArm64") return { textKey: "codexVersionLinux", guide: "install" };
    if (platform === "unsupported") return codexBlockers.CODEX_PLATFORM_UNQUALIFIED;
  }
  return Object.hasOwn(codexBlockers, code) ? codexBlockers[code] : { textKey: "codexUnavailable" };
}

/** Variables that change how a program starts: a tool receiving one deserves a visible warning. */
export const interpreterEnvironment: ReadonlySet<string> = new Set([
  "HOME", "TMPDIR", "TMP", "TEMP", "IFS", "CDPATH", "FPATH", "ZDOTDIR",
  "NODE_OPTIONS", "NODE_PATH", "PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP",
  "RUBYOPT", "RUBYLIB", "PERL5OPT", "PERL5LIB", "PERLLIB", "LUA_PATH", "LUA_CPATH",
  "CLASSPATH", "JAVA_TOOL_OPTIONS", "JDK_JAVA_OPTIONS", "_JAVA_OPTIONS",
]);

type Blocker = LaunchPreview["blockers"][number];

/**
 * What a blocker asks of the person: something they can fix right here, or something only the
 * author of the system can change. The text is always written for someone who does not build systems.
 */
export type BlockerView =
  | { kind: "model"; agent: string }
  | { kind: "folder" }
  | { kind: "mcpRemote"; server: string; technical: string; textKey: string }
  | ({ kind: "codex"; technical: string } & CodexBlocker)
  | { kind: "author"; textKey: string; subject: string; technical: string };

const authorCodes = new Set([
  "mcpIsolationUnavailable", "mcpWorkspaceRequired", "mcpRetainedProgramRequired",
  "mcpAbsoluteInterpreterRequired", "mcpReservedSecret", "unsupportedHarness",
]);

export function classifyBlocker({ code, subject, codexPlatform }: Blocker): BlockerView {
  const technical = [code, subject].filter(Boolean).join(" · ");
  if (code === "modelUnavailable") return { kind: "model", agent: subject };
  if (code === "workingFolderRequired") return { kind: "folder" };
  if (["mcpRemoteUnsupported", "mcpEndpointUnsupported", "mcpSecretDeliveryRequired", "mcpSecretHeader", "mcpSecretHeaderConflict",
    "mcpPrivateNetworkRequired", "mcpAddressScopeMismatch", "mcpAddressUnsupported"].includes(code))
    return { kind: "mcpRemote", server: subject, technical, textKey: code };
  if (code === "codexUnavailable") return { kind: "codex", ...codexBlocker(subject, codexPlatform), technical };
  return { kind: "author", textKey: authorCodes.has(code) ? code : "unknown", subject, technical };
}

/** A start can fail because what was checked earlier changed: the window then checks again. */
export function failureCode(failure: unknown): string {
  return failure && typeof failure === "object" && "code" in failure && typeof failure.code === "string" ? failure.code : "";
}

export function isRecheckFailure(code: string): boolean {
  return ["WORKING_FOLDER_IN_USE", "WORKING_FOLDER_CHANGED", "WORKING_FOLDER_UNAVAILABLE", "workingFolderRequired",
    "CONSENT_REQUIRED", "MODEL_UNAVAILABLE", "MCP_SECRETS_UNAVAILABLE",
    "mcpSecretDeliveryRequired", "mcpSecretHeader", "mcpSecretHeaderConflict",
    "mcpPrivateNetworkRequired", "mcpAddressScopeMismatch", "mcpAddressUnsupported"].includes(code) ||
    code.startsWith("CODEX_");
}

export function isFolderFailure(code: string): boolean {
  return ["WORKING_FOLDER_IN_USE", "WORKING_FOLDER_CHANGED", "WORKING_FOLDER_UNAVAILABLE", "workingFolderRequired"].includes(code);
}

/** A plain sentence for a failure, and the raw code kept for the details. */
export function failureText(failure: unknown, t: TFunction): { message: string; technical: string } {
  const diagnostic = failure as { code?: string; source?: { path: string; pointer: string } } | null;
  const code = failureCode(failure);
  if (code === "MCP_SECRET_RESERVED") {
    return { message: reservedMcpSecretText(t, diagnostic?.source?.path, diagnostic?.source?.pointer), technical: code };
  }
  if (code === "INVALID_LAUNCH_VALUES") return { message: t("agsdl.launch.fields.invalidValues", { ns: "agsdl" }), technical: code };
  if (code === "INVALID_LAUNCH_FIELDS") return { message: t("agsdl.launch.fields.invalidDefinition", { ns: "agsdl" }), technical: code };
  const invalid = ["GRAPH_LIMIT", "INPUT_LIMIT", "ARCHIVE_LAYOUT", "ARCHIVE_LIMIT", "ARCHIVE_INTEGRITY"].includes(code);
  return { message: t(invalid ? "agsdl.launch.invalidArchive" : "agsdl.launch.failed"), technical: code };
}

export const baseName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;

/** The dense select used across the launch window. */
/** Room on the right keeps the arrow of a narrow select visible. */
export const selectClass = "!rounded-md !py-1 !pl-2 !pr-7 !text-xs";

/** The searchable picker in the same dense size as the selects. */
export const comboboxClass = "!rounded-md !py-1 !pl-2 !text-xs";

type PreviewAgents = LaunchPreview["permissions"]["agents"];

/** Why the tools of a declared server are not connected, told per agent that lists it. */
export interface UnusedServerReason {
  /** `nobody`: no agent lists the server. `notAllowed`: agents list it, none is given its tools. */
  kind: "nobody" | "notAllowed";
  agents: Array<{ id: string; why: "readOnly" | "denied" | "policy" | "engine" | "notInFlow"; engine: string }>;
}

const engineLabels: Readonly<Record<string, string>> = { codex: "Codex", "claude-code": "Claude Code" };
export const engineLabel = (harness: string) => Object.hasOwn(engineLabels, harness) ? engineLabels[harness] : harness;

/**
 * Read from what the check already knows: which agents list the server, their engine and access,
 * and whether the flow reaches them. Only Codex agents can be given tools by this version of Macro.
 */
export function unusedServerReason(preview: LaunchPreview, server: string): UnusedServerReason {
  const agents = Object.entries(preview.permissions.agents)
    .filter(([, agent]) => agent.mcpServers.includes(server))
    .map(([id, agent]) => ({
      id, engine: engineLabel(agent.harness),
      why: agent.usage !== "reachable" ? "notInFlow" as const
        : agent.harness !== "codex" ? "engine" as const
          // The agent would be allowed, but the policy of this computer says no: that is not the author's to change.
          : preview.agentMcp[id]?.[server] && preview.agentMcp[id][server].agentDefault !== "deny" && preview.agentMcp[id][server].hostDefault === "deny" ? "policy" as const
            : (agent.permissions.preset ?? "read-only") === "read-only" ? "readOnly" as const : "denied" as const,
    }));
  return { kind: agents.length ? "notAllowed" : "nobody", agents };
}

/** Agents the flow hands work to, and those it never reaches. A system without a flow reaches none. */
export function flowReach(agents: PreviewAgents): { declared: string[]; unreached: string[] } {
  const declared = Object.keys(agents);
  return { declared, unreached: declared.filter(id => agents[id].usage !== "reachable") };
}
