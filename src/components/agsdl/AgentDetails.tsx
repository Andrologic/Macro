import { DisclosureSummary } from "./DisclosureSummary";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowDownToLine, ArrowUpFromLine, ArrowUpRight, Bot, Box, Braces, FileText, Settings2, Terminal, Wrench } from "lucide-react";
import type { ViewerCard, ViewerReference } from "../../services/agsdl/viewer";
import { agentConfigurations, outputRecipients } from "../../services/agsdl/agentDetails";
import { useAgsdlModelCatalogue, qualifiedModel } from "../../stores/useAgsdlModelCatalogue";
import { useAgsdlTranslation } from "./useAgsdlTranslation";

function ReferencePreview({ reference, cards, onSelect }: {
  reference: ViewerReference; cards: ViewerCard[]; onSelect: (path: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const target = !reference.unresolved && cards.find(card => card.path === reference.target);
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const tooltip = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [portal, setPortal] = useState<Element | null>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const show = () => {
    clearTimeout(closeTimer.current);
    setPortal(anchor.current?.closest('[role="dialog"]') ?? document.body);
    setOpen(true);
  };
  const hide = () => { closeTimer.current = setTimeout(() => setOpen(false), 120); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  useEffect(() => {
    if (!open || !portal) return;
    // Dialog handles Escape in document capture; dismiss the preview first.
    const dismiss = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || !(event.target instanceof Node) || !portal.contains(event.target)) return;
      event.preventDefault(); event.stopPropagation(); setOpen(false);
    };
    window.addEventListener("keydown", dismiss, true);
    return () => window.removeEventListener("keydown", dismiss, true);
  }, [open, portal]);
  useLayoutEffect(() => {
    if (!open || !anchor.current || !tooltip.current) return;
    const rect = anchor.current.getBoundingClientRect();
    const preview = tooltip.current.getBoundingClientRect();
    setPosition({ left: Math.max(12, Math.min(rect.left, window.innerWidth - preview.width - 12)),
      top: rect.bottom + preview.height + 12 <= window.innerHeight ? rect.bottom + 8 : Math.max(12, rect.top - preview.height - 8) });
    const close = () => setOpen(false);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [open]);
  if (!target) return <span className={reference.unresolved ? "agsdl-unresolved" : "agsdl-muted"}>{reference.label}</span>;
  const isAgent = ["Agent", "invoke", "agent"].includes(target.kind);
  const Icon = isAgent ? Bot : Box;
  const preview = target.mission || target.promptSources?.find(item => item.uri)?.uri ||
    (target.promptSources?.some(item => item.kind === "structured") ? t("agsdl.viewer.detail.structuredSource") : isAgent ? t("agsdl.viewer.noMission") : "");
  return <>
    <button ref={anchor} className="agsdl-reference-chip" aria-describedby={open ? id : undefined}
      onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={() => setOpen(false)}
      onClick={() => { setOpen(false); onSelect(target.path); }}>
      <Icon size={13} /><span>{target.title}</span><ArrowUpRight size={12} />
    </button>
    {open && portal && createPortal(<div ref={tooltip} id={id} role="tooltip" className="agsdl-reference-preview"
      style={position} onMouseEnter={show} onMouseLeave={hide}>
      <strong><Icon size={15} />{target.title}</strong>
      {preview && <p>{preview}</p>}
    </div>, portal)}
  </>;
}

function Parameters({ value }: { value: Record<string, unknown> }) {
  return <dl className="agsdl-configuration-values">{Object.entries(value).map(([key, item]) => <div key={key}>
    <dt>{key}</dt><dd>{item !== null && typeof item === "object"
      ? <details><DisclosureSummary>{Array.isArray(item) ? `${item.length}` : "…"}</DisclosureSummary><Parameters value={item as Record<string, unknown>} /></details>
      : String(item)}</dd>
  </div>)}</dl>;
}

export function AgentDetails({ card, cards, source, onSelect, captured = false }: {
  card: ViewerCard; cards: ViewerCard[]; source: string; captured?: boolean; onSelect: (path: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const configurations = agentConfigurations(source, card);
  const { catalogue, load } = useAgsdlModelCatalogue();
  useEffect(() => { void load().catch(() => {}); }, [load]);
  const reference = (ref: ViewerReference) => <ReferencePreview reference={ref} cards={cards} onSelect={onSelect} />;
  const configTools = configurations.flatMap(config => config.tools.map(tool => tool.reference));
  const tools = [...(card.tools ?? []), ...configTools].filter((ref, index, all) =>
    all.findIndex(other => other.target === ref.target && other.label === ref.label) === index);
  return <div className="agsdl-agent-details">
    {captured && <p className="agsdl-muted">{t("agsdl.execution.declaredConfiguration")}</p>}
    {card.participant && <p>{reference(card.participant)}</p>}
    <section className="agsdl-prompt-section">
      <h4><Terminal size={14} />{t("agsdl.viewer.detail.prompt")}</h4>
      {card.promptSources?.length ? card.promptSources.map((item, index) => <div className="agsdl-prompt-source" key={index}>
        {item.kind === "text" ? <p className="agsdl-prompt">{item.text}</p>
          : item.kind === "uri" ? <div className="agsdl-source-uri"><FileText size={14} /><span title={item.uri}>{item.uri}</span>{item.mediaType && <small>{item.mediaType}</small>}</div>
            : item.kind === "structured" ? <details className="agsdl-source-structured"><DisclosureSummary><Braces size={14} />{t("agsdl.viewer.detail.structuredSource")}{item.mediaType && <small>{item.mediaType}</small>}</DisclosureSummary><pre className="agsdl-source-value">{item.valueJson}</pre></details>
              : <span className="agsdl-unresolved">{t("agsdl.viewer.detail.unspecifiedSource")}</span>}
        {item.reference && <div className="agsdl-source-meta">{reference(item.reference)}</div>}
      </div>) : <p className={card.mission ? "agsdl-prompt" : "agsdl-muted"}>{card.mission || t("agsdl.viewer.noMission")}</p>}
    </section>
    <div className="agsdl-agent-io">
      <section><h4><ArrowDownToLine size={14} />{t("agsdl.viewer.detail.inputs")}</h4>
        {card.flowInputs?.map((input, index) => <div className="agsdl-io-card" key={`flow-${index}`}>
          <strong>{input.origin === "unknown" ? t("agsdl.viewer.detail.unspecifiedSource")
            : t(`agsdl.edge.${({ entry: "Message", prepare: "Message", agent: "completion", call: "data", join: "members", error: "failure" } as const)[input.origin]}`)}</strong>
          {input.reference.target && <div className="agsdl-io-origin">{reference(input.reference)}</div>}
        </div>)}
        {card.inputs.length ? card.inputs.map((port, index) => <div className="agsdl-io-card" key={`${port.name}-${index}`}>
          <strong>{port.name}</strong>
          <div className="agsdl-io-origin">
            {(port.binding?.source === "step" || port.binding?.target) ? <>{reference(port.binding)}{port.binding.port && <small>{t("agsdl.viewer.detail.fromPort", { port: port.binding.port })}</small>}</>
              : <div className="agsdl-muted">{port.binding?.source === "input" ? <>{t("agsdl.viewer.detail.systemInput")}{port.binding.label !== port.name && <small>{port.binding.label}</small>}</>
                : port.binding?.source === "literal" ? port.binding.valueJson
                  ? <details className="agsdl-source-structured"><DisclosureSummary><Braces size={14} />{t("agsdl.viewer.detail.structuredSource")}</DisclosureSummary><pre className="agsdl-source-value">{port.binding.valueJson}</pre></details>
                  : <>{t("agsdl.viewer.literal")}<small>{port.binding.label}</small></>
                  : port.binding?.uri ? <span className="agsdl-source-uri"><FileText size={14} /><span title={port.binding.uri}>{port.binding.uri}</span>{port.type && <small>{port.type}</small>}</span>
                    : t("agsdl.viewer.detail.unspecifiedSource")}</div>}
          </div>
        </div>) : !card.flowInputs?.length && <p className="agsdl-muted">{t("agsdl.viewer.detail.noInputs")}</p>}
        {!!card.dependencies?.length && <div className="agsdl-agent-dependencies"><span className="agsdl-muted">{t("agsdl.viewer.dependencies")}</span>{card.dependencies.map((ref, index) => <div key={index}>{reference(ref)}</div>)}</div>}
      </section>
      <section><h4><ArrowUpFromLine size={14} />{t("agsdl.viewer.detail.outputs")}</h4>
        {card.outputs.length ? card.outputs.map(port => {
          const recipients = outputRecipients(card, cards, port.name);
          return <div className="agsdl-io-card" key={port.name}><strong>{port.name}</strong>
            <div className="agsdl-io-origin">{recipients.length ? recipients.map(({ card: consumer, port: input }) => <div key={`${consumer.path}-${input}`}>
              {consumer.kind === "end" ? <span className="agsdl-muted">{t("agsdl.viewer.detail.systemResult")}</span>
                : reference({ target: consumer.path, label: consumer.title, source: "step" })}
              <small>{t("agsdl.viewer.detail.toPort", { port: input })}</small>
            </div>) : <span className="agsdl-muted">{t("agsdl.viewer.detail.noRecipient")}</span>}</div>
          </div>;
        }) : <p className="agsdl-muted">{t("agsdl.viewer.detail.noOutputs")}</p>}
      </section>
    </div>
    <section className="agsdl-agent-configuration"><h4><Wrench size={14} />{t("agsdl.viewer.detail.tools")}</h4>
      {tools.length ? <div className="agsdl-reference-list">{tools.map((ref, index) => <span key={index}>{reference(ref)}</span>)}</div>
        : <p className="agsdl-muted">{t("agsdl.viewer.detail.noTools")}</p>}
      {!!card.resources?.length && <div className="agsdl-resource-list"><span className="agsdl-muted">{t("agsdl.viewer.resources")}</span><div className="agsdl-reference-list">{card.resources.map((ref, index) => <span key={index}>{reference(ref)}</span>)}</div></div>}
      {configurations.map((config, index) => {
        const macro = config.macro ?? (["macro", "macro/desktop"].includes(config.engineIdentity) && config.engineVersion === "1");
        const providerId = typeof config.parameters.providerId === "string" ? config.parameters.providerId : "";
        const modelId = typeof config.parameters.modelId === "string" ? config.parameters.modelId : "";
        const choice = qualifiedModel(catalogue, providerId, modelId);
        const provider = choice ? { name: choice.providerName } : undefined;
        const model = choice ? { name: choice.modelName } : undefined;
        const unavailable = (id: string) => id
          ? `${id} · ${t("agsdl.macroConfig.unavailable", { defaultValue: "Unavailable locally" })}`
          : t("agsdl.macroConfig.unset", { defaultValue: "Not configured" });
        const parameters = macro ? Object.fromEntries(Object.entries(config.parameters).filter(([key]) => !["providerId", "modelId"].includes(key))) : config.parameters;
        if (card.details.contract !== "agsdl-0.2.0" && !macro && !Object.keys(parameters).length && !config.tools.length) {
          return <div className="agsdl-runtime-empty" key={`${config.id}-${index}`}><Settings2 size={13} />{config.engine || t("agsdl.viewer.detail.engineUnset")}</div>;
        }
        return <details className="agsdl-runtime-settings" key={`${config.id}-${index}`}>
          <DisclosureSummary><Settings2 size={13} />{macro ? model?.name || unavailable(modelId) : config.engine || t("agsdl.viewer.detail.engineUnset")}<span className="agsdl-muted">{macro && providerId ? provider?.name || unavailable(providerId) : config.id}{config.selected ? ` · ${t("agsdl.viewer.detail.selected")}` : ""}</span></DisclosureSummary>
          {config.engineReference && <div className="agsdl-engine-reference">{reference(config.engineReference)}</div>}
          {!!Object.keys(config.engineParameters ?? {}).length && <details className="agsdl-details"><DisclosureSummary>{t("agsdl.viewer.detail.engineSettings")}</DisclosureSummary><Parameters value={config.engineParameters ?? {}} /></details>}
          {macro && <dl className="agsdl-configuration-values">
            {configurations.length > 1 && <div><dt>{t("agsdl.macroConfig.title", { defaultValue: "Agent configuration" })}</dt><dd>{config.id}</dd></div>}
            <div><dt>{t("agsdl.macroConfig.provider", { defaultValue: "Provider" })}</dt><dd>{provider?.name || unavailable(providerId)}</dd></div>
            <div><dt>{t("agsdl.macroConfig.model", { defaultValue: "Model" })}</dt><dd>{model?.name || unavailable(modelId)}</dd></div>
          </dl>}
          {!!Object.keys(parameters).length && <details className="agsdl-details"><DisclosureSummary>{macro
            ? t("agsdl.macroConfig.parameters", { defaultValue: "Additional settings" })
            : t("agsdl.macroConfig.title", { defaultValue: "Agent configuration" })}</DisclosureSummary><Parameters value={parameters} /></details>}
          {config.tools.map((tool, i) => <div className="agsdl-tool-connection" key={i}>{reference(tool.reference)}
            {tool.choices.map((choice, j) => <div key={j}><p>{choice.implementation || choice.id}{choice.selected && <small> · {t("agsdl.viewer.detail.selected")}</small>}</p><Parameters value={choice.parameters} /></div>)}
          </div>)}
        </details>;
      })}
    </section>
  </div>;
}
