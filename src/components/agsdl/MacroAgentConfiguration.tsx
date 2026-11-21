import { useEffect, useState } from "react";
import { qualifiedModel, useAgsdlModelCatalogue } from "../../stores/useAgsdlModelCatalogue";
import type { MacroConfiguration } from "../../services/agsdl/macroAgentConfiguration";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "./macro-agent-configuration.css";
import { executionCodexStatus, executionClaudeStatus, executionClaudeSetApiKey } from "../../services/ipc/agsdlExecution";
import type { CodexStatus, ClaudeStatus } from "../../types/generated/ipc";

export function MacroAgentConfiguration({ configuration, providerId, modelId, disabled, onChange }: {
  configuration: MacroConfiguration; providerId: string; modelId: string; disabled: boolean;
  onChange: (providerId: string, modelId: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const [nativeStatus, setNativeStatus] = useState<CodexStatus | ClaudeStatus>();
  const [nativeStatusError, setNativeStatusError] = useState(false);
  const codex = configuration.engine === "codex";
  const claude = configuration.engine === "claude";
  const [apiKey, setApiKey] = useState("");
  const [keyState, setKeyState] = useState<"idle" | "saving" | "failed">("idle");
  useEffect(() => {
    if (!codex && !claude) return;
    let current = true;
    setNativeStatus(undefined); setNativeStatusError(false);
    void (claude ? executionClaudeStatus() : executionCodexStatus()).then(status => { if (current) setNativeStatus(status); }).catch(() => { if (current) setNativeStatusError(true); });
    return () => { current = false; };
  }, [codex, claude]);
  const { catalogue, loading, error, load } = useAgsdlModelCatalogue();
  useEffect(() => { if (configuration.editable) void load(true).catch(() => {}); }, [configuration.editable, load]);
  const qualified = catalogue?.models.filter(model => qualifiedModel(catalogue, model.providerId, model.modelId) && (codex ? model.providerId === "codex-native" : claude ? model.providerId === "claude-native" : !["codex-native", "claude-native"].includes(model.providerId))) ?? [];
  const choices = [...new Map(qualified.map(model => [model.providerId, { id: model.providerId, name: model.providerName }])).values()];
  const models = qualified.filter(model => model.providerId === providerId);
  const nativeCode = catalogue?.unavailableProviders.find(provider => provider.providerId === "codex-native")?.code ?? nativeStatus?.code;
  const nativeMessage = nativeStatusError ? "diagnosticFailed" : !nativeCode ? "checking" : ({
    CODEX_NOT_INSTALLED: "notInstalled", CODEX_VERSION_UNQUALIFIED: "versionUnqualified",
    CODEX_PLATFORM_UNQUALIFIED: "platformUnqualified", CODEX_LOGIN_REQUIRED: "loginRequired",
    CODEX_SCOPE_CHECK_REQUIRED: "assessmentRequired", CODEX_PROFILE_UNQUALIFIED: "profileUnqualified", CODEX_SANDBOX_UNQUALIFIED: "sandboxUnqualified",
    CODEX_ACCOUNT_UNQUALIFIED: "accountUnqualified", CODEX_CONTEXT_UNQUALIFIED: "contextUnqualified", STOP_PENDING: "stopPending",
  }[nativeCode] ?? "profileUnqualified");
  const claudeCode = catalogue?.unavailableProviders.find(provider => provider.providerId === "claude-native")?.code ?? nativeStatus?.code;
  const claudeMessage = nativeStatusError ? "diagnosticFailed" : !claudeCode ? "checking" : ({
    CLAUDE_NOT_INSTALLED: "notInstalled", CLAUDE_KEY_REQUIRED: "keyRequired", CLAUDE_VERSION_UNQUALIFIED: "versionUnqualified",
    CLAUDE_PLATFORM_UNQUALIFIED: "platformUnqualified", CLAUDE_CONTROLLED_READY: "ready", STOP_PENDING: "stopPending",
  }[claudeCode] ?? "profileUnqualified");
  const saveKey = async () => {
    setKeyState("saving");
    try { await executionClaudeSetApiKey(apiKey); setApiKey(""); setNativeStatus(await executionClaudeStatus()); await load(true); setKeyState("idle"); }
    catch { setKeyState("failed"); }
  };
  return <section className="agsdl-macro-config">
    <header><strong>{t("agsdl.macroConfig.title", { defaultValue: "Agent configuration" })}</strong>{configuration.editable && <span>{codex ? "Codex" : claude ? "Claude" : "Macro"}</span>}</header>
    {codex && <><p className="agsdl-muted">{t("agsdl.codex.policy")}</p>
      <p role="status">{t(`agsdl.codex.${nativeMessage}`)}</p></>}
    {claude && <><p className="agsdl-muted">{t("agsdl.claude.policy")}</p>
      <p role="status">{t(`agsdl.claude.${claudeMessage}`)}</p>
      <a href="https://platform.claude.com/docs/en/agent-sdk/quickstart" target="_blank" rel="noreferrer">{t("agsdl.claude.installation")}</a>
      <label className="agsdl-edit-field"><span>{t("agsdl.claude.apiKey")}</span><input type="password" autoComplete="off" value={apiKey} disabled={disabled || keyState === "saving"} onChange={event => setApiKey(event.target.value)} /></label>
      <button type="button" disabled={disabled || !apiKey.trim() || keyState === "saving"} onClick={() => void saveKey()}>{t("agsdl.save")}</button>
      {keyState === "failed" && <p role="status">{t("agsdl.claude.keySaveFailed")}</p>}
    </>}
    {configuration.editable ? <div className="agsdl-macro-config-fields">
      <label className="agsdl-edit-field"><span>{t("agsdl.macroConfig.provider", { defaultValue: "Provider" })}</span>
        <select value={providerId} disabled={disabled || loading || !catalogue} onChange={event => onChange(event.target.value, "")}>
          <option value="">{t("agsdl.macroConfig.chooseProvider", { defaultValue: "Choose a provider" })}</option>
          {providerId && !choices.some(provider => provider.id === providerId) && <option value={providerId}>{t("agsdl.macroConfig.unavailable", { defaultValue: "Unavailable locally" })}</option>}
          {choices.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select></label>
      <label className="agsdl-edit-field"><span>{t("agsdl.macroConfig.model", { defaultValue: "Model" })}</span>
        <select value={modelId} disabled={disabled || loading || !catalogue || !providerId} onChange={event => onChange(providerId, event.target.value)}>
          <option value="">{t("agsdl.macroConfig.chooseModel", { defaultValue: "Choose a model" })}</option>
          {modelId && !models.some(model => model.modelId === modelId) && <option value={modelId}>{modelId} · {t("agsdl.macroConfig.unavailable", { defaultValue: "Unavailable locally" })}</option>}
          {models.map(model => <option value={model.modelId} key={model.modelId}>{model.modelName}</option>)}
        </select></label>
      {loading && <p role="status">{t("agsdl.loading")}</p>}
      {error && <p role="status">{t("agsdl.macroConfig.unavailable")} <button type="button" onClick={() => void load(true).catch(() => {})}>{t("agsdl.retry")}</button></p>}
      {!loading && !error && catalogue && qualified.length === 0 && <p className="agsdl-muted">{t("agsdl.macroConfig.unavailable")}</p>}
    </div> : <p className="agsdl-muted">{t("agsdl.macroConfig.unsupported", { defaultValue: "This runtime configuration cannot be edited here. Ask the agent to prepare an unambiguous Macro binding." })}</p>}
  </section>;
}
