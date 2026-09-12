import { useProviderStore } from "../../stores/useProviderStore";
import type { MacroConfiguration } from "../../services/agsdl/macroAgentConfiguration";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import "./macro-agent-configuration.css";

export function MacroAgentConfiguration({ configuration, providerId, modelId, disabled, onChange }: {
  configuration: MacroConfiguration; providerId: string; modelId: string; disabled: boolean;
  onChange: (providerId: string, modelId: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const providers = useProviderStore(state => state.providers);
  const modelsByProvider = useProviderStore(state => state.modelsByProvider);
  const choices = providers.filter(provider => provider.isEnabled !== false);
  const models = (modelsByProvider[providerId] ?? []).filter(model => model.isEnabled !== false);
  return <section className="agsdl-macro-config">
    <header><strong>{t("agsdl.macroConfig.title", { defaultValue: "Agent configuration" })}</strong>{configuration.editable && <span>Macro</span>}</header>
    {configuration.editable ? <div className="agsdl-macro-config-fields">
      <label className="agsdl-edit-field"><span>{t("agsdl.macroConfig.provider", { defaultValue: "Provider" })}</span>
        <select value={providerId} disabled={disabled} onChange={event => onChange(event.target.value, "")}>
          <option value="">{t("agsdl.macroConfig.chooseProvider", { defaultValue: "Choose a provider" })}</option>
          {providerId && !choices.some(provider => provider.id === providerId) && <option value={providerId}>{t("agsdl.macroConfig.unavailable", { defaultValue: "Unavailable locally" })}</option>}
          {choices.map(provider => <option value={provider.id} key={provider.id}>{provider.name}</option>)}
        </select></label>
      <label className="agsdl-edit-field"><span>{t("agsdl.macroConfig.model", { defaultValue: "Model" })}</span>
        <select value={modelId} disabled={disabled || !providerId} onChange={event => onChange(providerId, event.target.value)}>
          <option value="">{t("agsdl.macroConfig.chooseModel", { defaultValue: "Choose a model" })}</option>
          {modelId && !models.some(model => model.id === modelId) && <option value={modelId}>{modelId} · {t("agsdl.macroConfig.unavailable", { defaultValue: "Unavailable locally" })}</option>}
          {models.map(model => <option value={model.id} key={model.id}>{model.name}</option>)}
        </select></label>
    </div> : <p className="agsdl-muted">{t("agsdl.macroConfig.unsupported", { defaultValue: "This runtime configuration cannot be edited here. Ask the agent to prepare an unambiguous Macro binding." })}</p>}
  </section>;
}
