import React, { useEffect, useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import {
  useAgsdlStore,
  agsdlSessionKey,
  type AgsdlTarget,
} from "../../stores/useAgsdlStore";
import {
  projectViewer,
  type ViewerCard,
  type ViewerPort,
  type ViewerReference,
} from "../../services/agsdl/viewer";
import "./agsdl.css";

// Keep the integration contract while the document is edited exclusively through chat.
export const AgsdlEditor: React.FC<{
  target: AgsdlTarget;
  planStatus?: string;
  expanded?: boolean;
  onExpand?: () => void;
}> = ({ target, expanded, onExpand }) => {
  const { t } = useAgsdlTranslation();
  const key = agsdlSessionKey(target);
  const session = useAgsdlStore((state) => state.sessions[key]);
  const [error, setError] = useState("");
  const [graphIndex, setGraphIndex] = useState(0);
  const [selection, setSelection] = useState<{ key: string; path: string }>();
  useEffect(() => {
    let active = true;
    useAgsdlStore
      .getState()
      .load(target)
      .then(() => {
        if (active) setError("");
      })
      .catch((error: unknown) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [target]);
  const source = session?.source;
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => void useAgsdlStore.getState().validate(target), 250);
    return () => clearTimeout(timer);
  }, [source, target]);
  const parsed = useMemo(() => {
    if (!source) return {};
    try {
      return { document: projectViewer(source) };
    } catch (error) {
      return { error: String(error) };
    }
  }, [source]);
  const document = parsed.document;
  const visibleGraphIndex = Math.min(graphIndex, Math.max(0, (document?.graphs.length ?? 0) - 1));
  const graph = document?.graphs[visibleGraphIndex];
  const selected = selection?.key === key ? selection.path : "";
  const select = (path: string) => {
    setSelection({ key, path });
    window.requestAnimationFrame(() =>
      window.document
        .getElementById(`agsdl${path}`)
        ?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
    );
  };
  const referenceLabel = (ref: ViewerReference) => {
    const destination = graph?.cards.find((card) => card.path === ref.target);
    return destination?.kind === "end" &&
      !(destination.details.annotations as { title?: string } | undefined)
        ?.title
      ? t(`agsdl.edge.${destination.outcome}`, { defaultValue: ref.label })
      : ref.label;
  };
  const reference = (ref: ViewerReference) => (
    <span className={ref.unresolved ? "agsdl-unresolved" : ""}>
      {ref.source === "input" && (
        <span className="agsdl-muted">{t("agsdl.viewer.graphInput")} · </span>
      )}
      {ref.source === "literal" && (
        <span className="agsdl-muted">{t("agsdl.viewer.literal")} · </span>
      )}
      {ref.target ? (
        <button className="agsdl-link" onClick={() => select(ref.target!)}>
          {referenceLabel(ref)}
        </button>
      ) : (
        ref.label || t("agsdl.viewer.unspecified")
      )}
      {ref.unresolved && <span> · {t("agsdl.viewer.unresolved")}</span>}
    </span>
  );
  const portList = (
    items: ViewerPort[],
    direction: "inputs" | "outputs",
    expanded = false,
  ) =>
    items.length > 0 && (
      <section className="agsdl-ports">
        <h4>{t(`agsdl.viewer.${direction}`)}</h4>
        {items.map((port) => (
          <div className="agsdl-port" key={port.name}>
            <strong>{port.name}</strong>
            {expanded && port.type && (
              <span className="agsdl-muted">{port.type}</span>
            )}
            {(direction === "inputs" || port.binding) && (
              <div className="agsdl-provenance">
                {" "}
                ←
                {port.binding
                  ? reference(port.binding)
                  : t("agsdl.viewer.noBinding")}
              </div>
            )}
          </div>
        ))}
      </section>
    );
  const card = (item: ViewerCard) => (
    <article
      id={`agsdl${item.path}`}
      key={item.path}
      className={`agsdl-card ${selected === item.path ? "agsdl-card-selected" : ""}`}
    >
      <button
        className="agsdl-card-heading"
        aria-expanded={selected === item.path}
        onClick={() =>
          setSelection({ key, path: selected === item.path ? "" : item.path })
        }
      >
        <span className="agsdl-muted">
          {t(`agsdl.kind.${item.kind}`, { defaultValue: item.kind })}
        </span>
        <h3>
          {item.kind === "end" && !(item.details.annotations as { title?: string } | undefined)?.title
            ? t(`agsdl.edge.${item.outcome}`, { defaultValue: item.title })
            : item.title || t("agsdl.viewer.unnamed")}
        </h3>
        <ChevronRight size={14} aria-hidden="true" className="agsdl-card-disclosure" />
      </button>
      {item.outcome && (item.details.annotations as { title?: string } | undefined)?.title && (
        <p>{t(`agsdl.edge.${item.outcome}`, { defaultValue: item.outcome })}</p>
      )}
      {item.dependencies && (
        <section className="agsdl-branches">
          <h4>{t("agsdl.viewer.dependencies")}</h4>
          {item.dependencies.length ? (
            item.dependencies.map((ref, index) => (
              <div key={index}>{reference(ref)}</div>
            ))
          ) : (
            <p className="agsdl-muted">{t("agsdl.none")}</p>
          )}
          <p className="agsdl-muted">{t("agsdl.viewer.unknownTransfers")}</p>
        </section>
      )}
      {item.unresolved && (
        <p className="agsdl-unresolved">{t("agsdl.viewer.unresolvedAgent")}</p>
      )}
      {item.mission ? (
        <p
          className={`agsdl-mission ${selected !== item.path ? "agsdl-mission-preview" : ""}`}
        >
          {item.mission}
        </p>
      ) : item.kind === "invoke" || item.kind === "Agent" ? (
        <p className="agsdl-muted">{t("agsdl.viewer.noMission")}</p>
      ) : null}
      {selected === item.path && (
        <>
          {item.tools?.length ? (
            <p>
              <strong>{t("agsdl.agentTools")}</strong> ·{" "}
              {item.tools.map((ref, index) => (
                <span key={index}>
                  {index > 0 ? ", " : ""}
                  {reference(ref)}
                </span>
              ))}
            </p>
          ) : null}
          {item.resources?.length ? (
            <p>
              <strong>{t("agsdl.viewer.resources")}</strong> ·{" "}
              {item.resources.map((ref, index) => (
                <span key={index}>
                  {index > 0 ? ", " : ""}
                  {reference(ref)}
                </span>
              ))}
            </p>
          ) : null}
        </>
      )}
      {portList(item.inputs, "inputs", selected === item.path)}
      {portList(item.outputs, "outputs", selected === item.path)}
      {item.branches.length > 0 && (
        <section className="agsdl-branches">
          <h4>{t("agsdl.viewer.control")}</h4>
          {item.branches.map((branch) => (
            <div key={branch.label}>
              <strong>{t(`agsdl.edge.${branch.label}`)}</strong>
              <span> → {reference(branch.reference)}</span>
            </div>
          ))}
        </section>
      )}
      {selected === item.path && (
        <details className="agsdl-details">
          <summary>{t("agsdl.viewer.technicalDetails")}</summary>
          <ReadOnlyValue value={item.details} />
        </details>
      )}
    </article>
  );
  const findings =
    session?.reports.flatMap((report) =>
      report.results.flatMap((result) => result.findings),
    ) ?? [];
  return (
    <div className="agsdl-viewer" aria-label={t("agsdl.editor")}>
      <header className="agsdl-viewer-header">
        <strong title={document?.title}>{document?.title || t("agsdl.editor")}</strong>
        <p>{t("agsdl.viewer.chatHint")}</p>
        {onExpand && (
          <button className="agsdl-link" onClick={onExpand}>
            {t(expanded ? "agsdl.shrink" : "agsdl.expand")}
          </button>
        )}
        {document && document.graphs.length > 1 && (
          <select
            aria-label={t("agsdl.graph")}
            value={visibleGraphIndex}
            onChange={(event) => {
              setGraphIndex(Number(event.target.value));
              setSelection(undefined);
            }}
          >
            {document.graphs.map((graph, index) => (
              <option key={graph.path} value={index}>
                {graph.title || `${t("agsdl.graph")} ${index + 1}`}
              </option>
            ))}
          </select>
        )}
      </header>
      {(error || session?.error || parsed.error) && (
        <div role="alert" className="agsdl-error">
          {error || session?.error || (
            <>
              <p>{t("agsdl.viewer.unreadable")}</p>
              <details className="agsdl-details">
                <summary>{t("agsdl.viewer.technicalDetails")}</summary>
                <p>{parsed.error}</p>
              </details>
            </>
          )}
          {(error || session?.error) && (
            <button
              className="agsdl-link"
              disabled={session?.saving}
              onClick={() => {
                const store = useAgsdlStore.getState();
                // Preserve the agent's unsaved work when retrying a failed save.
                void (session?.dirty ? store.save(target) : store.load(target, true))
                  .then(() => store.validate(target))
                  .then(() => setError(""))
                  .catch((error: unknown) => setError(String(error)));
              }}
            >
              {t("agsdl.retry")}
            </button>
          )}
        </div>
      )}
      <div className="agsdl-reading">
        {!session ? (
          <p>{t("agsdl.loading")}</p>
        ) : !session.source ? (
          <div className="agsdl-empty">
            <strong>{t("agsdl.emptyTitle")}</strong>
            <p>{t("agsdl.emptyDescription")}</p>
          </div>
        ) : (
          document && (
            <>
              {document.migrated && (
                <p className="agsdl-migration-note">
                  {t("agsdl.viewer.migrationNote")}{" "}
                  {document.migrationIssues
                    .filter((issue) => issue !== "execution-not-migrated")
                    .map((issue) =>
                      t(`agsdl.viewer.issues.${issue}`, {
                        defaultValue: issue,
                      }),
                    )
                    .join(" ")}
                </p>
              )}
              {graph ? (
                <>
                  <section className="agsdl-graph-summary">
                    <h3>{graph.title || t("agsdl.graph")}</h3>
                    <div>
                      {t("agsdl.viewer.entry")} → {reference(graph.entry)}
                    </div>
                    {graph.inputs.length > 0 && (
                      <div>
                        <strong>{t("agsdl.viewer.graphInputs")}</strong> ·{" "}
                        {graph.inputs.map((port) => port.name).join(", ")}
                      </div>
                    )}
                    {graph.outputs.length > 0 && (
                      <div>
                        <strong>{t("agsdl.viewer.graphOutputs")}</strong> ·{" "}
                        {graph.outputs.map((port) => port.name).join(", ")}
                      </div>
                    )}
                  </section>
                  {graph.cards.map(card)}
                  {graph.cards.length === 0 && <p>{t("agsdl.noGraph")}</p>}
                </>
              ) : (
                <>
                  <p className="agsdl-muted">{t("agsdl.viewer.declarative")}</p>
                  {(document.legacyCards.length
                    ? document.legacyCards
                    : document.declarations.filter(
                        (item) => item.kind === "Agent",
                      )
                  ).map(card)}
                </>
              )}
              {document.declarations.length > 0 && (
                <details className="agsdl-details">
                  <summary>
                    {t("agsdl.allDeclarations")} ·{" "}
                    {document.declarations.length}
                  </summary>
                  {document.declarations.map(card)}
                </details>
              )}
              {document.unresolved.length > 0 && (
                <details className="agsdl-details" open>
                  <summary>
                    {t("agsdl.viewer.unresolved")} ·{" "}
                    {document.unresolved.length}
                  </summary>
                  <ReadOnlyValue value={document.unresolved} />
                </details>
              )}
              {document.dependencies.length > 0 && (
                <details className="agsdl-details">
                  <summary>
                    {t("agsdl.dependencies")} · {document.dependencies.length}
                  </summary>
                  <ReadOnlyValue value={document.dependencies} />
                </details>
              )}
            </>
          )
        )}
        {findings.length > 0 && (
          <details className="agsdl-details">
            <summary>
              {t("agsdl.diagnostics")} · {findings.length}
            </summary>
            {findings.map((finding, index) => (
              <p key={index}>
                <strong>{finding.rule}</strong> {finding.details}
              </p>
            ))}
          </details>
        )}
      </div>
      <footer className="agsdl-status" aria-live="polite">
        {session?.saving ? t("agsdl.saving") : session?.dirty ? t("agsdl.unsaved") : t("agsdl.viewer.authoring")}
      </footer>
    </div>
  );
};

function ReadOnlyValue({ value }: { value: unknown }): React.ReactNode {
  if (value === null || typeof value !== "object")
    return <span className="agsdl-value">{String(value)}</span>;
  return (
    <dl className="agsdl-properties">
      {Object.entries(value).map(([key, item]) => (
        <div key={key}>
          <dt>{key}</dt>
          <dd>
            <ReadOnlyValue value={item} />
          </dd>
        </div>
      ))}
    </dl>
  );
}
