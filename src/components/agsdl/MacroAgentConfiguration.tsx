import { useEffect, useState } from "react";
import { qualifiedModel, useAgsdlModelCatalogue } from "../../stores/useAgsdlModelCatalogue";
import type { MacroConfiguration } from "../../services/agsdl/macroAgentConfiguration";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "./macro-agent-configuration.css";
import { executionCodexStatus } from "../../services/ipc/agsdlExecution";
import type { CodexStatus } from "../../types/generated/ipc";

export function MacroAgentConfiguration({ configuration, providerId, modelId, disabled, onChange }: {
  configuration: MacroConfiguration; providerId: string; modelId: string; disabled: boolean;
  onChange: (providerId: string, modelId: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const [nativeStatus, setNativeStatus] = useState<CodexStatus>();
  const [nativeStatusError, setNativeStatusError] = useState(false);
  const codex = configuration.engine === "codex";
  useEffect(() => {
    if (!codex) return;
    let current = true;
    setNativeStatus(undefined); setNativeStatusError(false);
    void executionCodexStatus().then(status => { if (current) setNativeStatus(status); }).catch(() => { if (current) setNativeStatusError(true); });
    return () => { current = false; };
  }, [codex]);
  const { catalogue, loading, error, load } = useAgsdlModelCatalogue();
  useEffect(() => { if (configuration.editable) void load(true).catch(() => {}); }, [configuration.editable, load]);
  const qualified = catalogue?.models.filter(model => qualifiedModel(catalogue, model.providerId, model.modelId) && (codex ? model.providerId === "codex-native" : model.providerId !== "codex-native")) ?? [];
  const choices = [...new Map(qualified.map(model => [model.providerId, { id: model.providerId, name: model.providerName }])).values()];
  const models = qualified.filter(model => model.providerId === providerId);
  const nativeCode = catalogue?.unavailableProviders.find(provider => provider.providerId === "codex-native")?.code ?? nativeStatus?.code;
  const nativeMessage = nativeStatusError ? "diagnosticFailed" : !nativeCode ? "checking" : ({
    CODEX_NOT_INSTALLED: "notInstalled", CODEX_VERSION_UNQUALIFIED: "versionUnqualified",
    CODEX_PLATFORM_UNQUALIFIED: "platformUnqualified", CODEX_LOGIN_REQUIRED: "loginRequired",
    CODEX_SCOPE_CHECK_REQUIRED: "assessmentRequired", CODEX_PROFILE_UNQUALIFIED: "profileUnqualified", CODEX_SANDBOX_UNQUALIFIED: "sandboxUnqualified",
    CODEX_ACCOUNT_UNQUALIFIED: "accountUnqualified", CODEX_CONTEXT_UNQUALIFIED: "contextUnqualified", STOP_PENDING: "stopPending",
  }[nativeCode] ?? "profileUnqualified");
  return <section className="agsdl-macro-config">
    <header><strong>{t("agsdl.macroConfig.title", { defaultValue: "Agent configuration" })}</strong>{configuration.editable && <span>{codex ? "Codex" : "Macro"}</span>}</header>
    {codex && <><p className="agsdl-muted">{t("agsdl.codex.policy")}</p>
      <p role="status">{t(`agsdl.codex.${nativeMessage}`)}</p></>}
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
