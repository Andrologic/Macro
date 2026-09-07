import React, { useEffect, useMemo, useRef, useState } from "react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import type { Connection } from "@xyflow/react";
import {
  useAgsdlStore,
  agsdlSessionKey,
  type AgsdlTarget,
} from "../../stores/useAgsdlStore";
import {
  AGSDL_CONTRACT,
  decodeSource,
  list,
  MAX_AGSDL_BYTES,
  object,
  readDocument,
  sourceAt,
  text,
} from "../../services/agsdl/document";
import {
  AGSDL_EXAMPLES,
  createExample,
  type AgsdlExample,
} from "../../services/agsdl/examples";
import { addAgent, addDefinition, addStep } from "../../services/agsdl/editing";
import { projectDocument } from "../../services/agsdl/projection";
import { AgsdlCanvas } from "./AgsdlCanvas";
import { AgsdlInspector, JsonEditor, AgsdlDraftTarget } from "./AgsdlInspector";
import { Dialog } from "../ui/Dialog";
import { Icon } from "../ui/Icon";

const store = useAgsdlStore.getState;

const download = (source: string, name: string) => {
  const url = URL.createObjectURL(
    new Blob([source], { type: "application/json;charset=utf-8" }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

export const AgsdlEditor: React.FC<{
  target: AgsdlTarget;
  planStatus?: string;
}> = ({ target, planStatus }) => {
  const { t } = useAgsdlTranslation();
  const key = agsdlSessionKey(target);
  const session = useAgsdlStore((state) => state.sessions[key]);
  const source = session?.source ?? "";
  const [view, setView] = useState<
    "process" | "system" | "configuration" | "source"
  >("process");
  const [systemScope, setSystemScope] = useState("first");
  const [graphIndex, setGraphIndex] = useState(0);
  const [configIndex, setConfigIndex] = useState(0);
  const [selected, setSelected] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [error, setError] = useState("");
  const [showDiagnostics, setShowDiagnostics] = useState(false);
  const [pendingReload, setPendingReload] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const annexInput = useRef<HTMLInputElement>(null);
  const [annexId, setAnnexId] = useState("");
  useEffect(() => {
    let active = true;
    store()
      .load(target)
      .catch((error) => {
        if (active) setError(String(error));
      });
    return () => {
      active = false;
    };
  }, [target]);
  const act = async (action: () => unknown | Promise<unknown>) => {
    try {
      await action();
      setError("");
    } catch (error) {
      setError(error instanceof Error ? error.message : String(error));
    }
  };
  const parsed = useMemo(() => {
    if (!source) return { doc: null, error: "" };
    try {
      return { doc: readDocument(source), error: "" };
    } catch (error) {
      return { doc: null, error: String(error) };
    }
  }, [source]);
  const doc = parsed.doc;
  const agents = list(doc?.definitions)
    .map((value, index) => ({
      value: object(value),
      path: `/definitions/${index}`,
    }))
    .filter((item) => item.value.kind === "Agent");
  const firstAgentIndex = list(doc?.definitions).findIndex(
    (value) => object(value).kind === "Agent",
  );
  const focusedAgent =
    systemScope === "first"
      ? firstAgentIndex >= 0
        ? `/definitions/${firstAgentIndex}`
        : undefined
      : systemScope === "all"
        ? undefined
        : systemScope;

  const graphCount = list(doc?.graphs).length;
  const inspectedGraph = Math.min(graphIndex, Math.max(0, graphCount - 1));
  const projection = useMemo(() => {
    try {
      return source && doc
        ? projectDocument(
            source,
            view === "system" ? "system" : "process",
            inspectedGraph,
            focusedAgent,
          )
        : { nodes: [], edges: [] };
    } catch {
      return { nodes: [], edges: [] };
    }
  }, [source, doc, view, inspectedGraph, focusedAgent]);
  const findings = useMemo(() => {
    const seen = new Set<string>();
    return (session?.reports ?? [])
      .flatMap((report) =>
        report.results.flatMap((result) =>
          result.findings.map((finding) => ({
            ...finding,
            input: result.input,
          })),
        ),
      )
      .filter((finding) => {
        const key = JSON.stringify(finding);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }, [session?.reports]);
  const problemPaths = useMemo(
    () =>
      findings
        .filter((finding) => finding.input === "primary")
        .map((finding) => finding.location.pointer ?? ""),
    [findings],
  );
  const hasFieldDrafts = Object.values(session?.fieldDrafts ?? {}).some(
    (draft) => draft.value !== draft.base,
  );
  useEffect(() => {
    if (!session?.dirty && !hasFieldDrafts) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [session?.dirty, hasFieldDrafts]);
  const readOnly = (planStatus ?? session?.status) !== "draft";
  const structuredReadOnly = readOnly || doc?.contract !== AGSDL_CONTRACT;
  useEffect(() => {
    if (!source) return;
    const timer = setTimeout(() => {
      void store().validate(target);
    }, 400);
    return () => clearTimeout(timer);
  }, [session?.version, source, target]);
  const connect = (connection: Connection) =>
    void act(() => {
      if (!session || !connection.source || !connection.target) return;
      if (view === "process") {
        const targetStep = object(
          JSON.parse(sourceAt(session.source, connection.target)),
        );
        store().edit(
          target,
          [
            {
              op: "set",
              path: `${connection.source}/${connection.sourceHandle}`,
              valueJson: JSON.stringify(targetStep.id),
            },
          ],
          session.version,
        );
      } else {
        const from = object(
          JSON.parse(sourceAt(session.source, connection.source)),
        );
        const to = object(
          JSON.parse(sourceAt(session.source, connection.target)),
        );
        const relation =
          from.kind === "Agent"
            ? to.kind === "Principal"
              ? "actsAs"
              : to.kind === "Interface"
                ? "exposes"
                : ["Instructions", "Skill", "Role", "ControlFlow"].includes(
                      text(to.kind),
                    )
                  ? "directedBy"
                  : "uses"
            : "uses";
        store().edit(
          target,
          [
            {
              op: "set",
              path: "/relations/-",
              valueJson: JSON.stringify({
                source: from.key,
                relation,
                target: to.key,
                expectedKind: to.kind,
              }),
            },
          ],
          session.version,
        );
      }
    });
  const importFile = (file: File | undefined, annex = false) =>
    void act(async () => {
      if (!file || !session) return;
      if (file.size > MAX_AGSDL_BYTES) throw new Error(t("agsdl.tooLarge"));
      const source = decodeSource(await file.arrayBuffer());
      if (annex) {
        if (!annexId) throw new Error(t("agsdl.chooseDependency"));
        store().replace(
          target,
          session.source,
          { ...session.annexes, [annexId]: source },
          session.version,
        );
      } else {
        store().replace(target, source, {}, session.version);
        setSelected("");
        setView("source");
      }
    });
  const selectFinding = (pointer: string, input: string) => {
    if (input !== "primary") {
      setView("source");
      return;
    }
    if (/^\/graphs\/\d+\/steps\/\d+/.test(pointer)) {
      setView("process");
      setGraphIndex(Number(pointer.split("/")[2]));
      setSelected(pointer.match(/^\/graphs\/\d+\/steps\/\d+/)![0]);
    } else if (/^\/definitions\/\d+/.test(pointer)) {
      setView("system");
      setSystemScope("all");
      setSelected(pointer.match(/^\/definitions\/\d+/)![0]);
    } else {
      setView("source");
      setSelected("");
    }
  };
  if (!session)
    return (
      <div className="agsdl-editor">
        <div className="agsdl-empty">
          {error || t("agsdl.loading")}
          {error && (
            <button
              className="agsdl-button"
              onClick={() => void act(() => store().load(target, true))}
            >
              {t("agsdl.reload")}
            </button>
          )}
        </div>
      </div>
    );

  const configurations = list(object(doc?.runtime).configurations).map(object);
  const inspectedConfig = Math.min(
    configIndex,
    Math.max(0, configurations.length - 1),
  );
  const configuration = configurations[inspectedConfig];
  const content = (
    <div className={`agsdl-editor ${expanded ? "agsdl-expanded" : ""}`}>
      <div className="agsdl-toolbar">
        <strong className="text-xs mr-auto">
          AgSDL <span className="text-muted-foreground font-normal">0.1.0</span>
        </strong>
        <button
          className="agsdl-button"
          disabled={!session.history.length || readOnly}
          onClick={() => store().undo(target)}
          title={t("agsdl.undo")}
          aria-label={t("agsdl.undo")}
        >
          <Icon name="undo-2" size={14} />
        </button>
        <button
          className="agsdl-button"
          disabled={!session.future.length || readOnly}
          onClick={() => store().undo(target, true)}
          title={t("agsdl.redo")}
          aria-label={t("agsdl.redo")}
        >
          <Icon name="redo-2" size={14} />
        </button>
        <button
          className="agsdl-button"
          disabled={
            !session.dirty || session.saving || readOnly || hasFieldDrafts
          }
          onClick={() => void act(() => store().save(target))}
        >
          {t(session.saving ? "agsdl.saving" : "agsdl.save")}
        </button>
        <button
          className="agsdl-button"
          aria-label={t(expanded ? "agsdl.shrink" : "agsdl.expand")}
          title={t(expanded ? "agsdl.shrink" : "agsdl.expand")}
          onClick={() => setExpanded(!expanded)}
        >
          <Icon name={expanded ? "minimize" : "expand"} size={14} />
        </button>
      </div>
      <div className="agsdl-toolbar">
        {(["process", "system", "configuration", "source"] as const).map(
          (mode) => (
            <button
              key={mode}
              className="agsdl-button"
              aria-pressed={view === mode}
              onClick={() => {
                setView(mode);
                setSelected("");
              }}
            >
              {t(`agsdl.${mode}`)}
            </button>
          ),
        )}
      </div>
      <div className="agsdl-toolbar">
        <input
          ref={fileInput}
          type="file"
          accept=".json,.agsdl,application/json"
          className="hidden"
          aria-label={t("agsdl.import")}
          onChange={(event) => {
            importFile(event.target.files?.[0]);
            event.target.value = "";
          }}
        />
        <button
          className="agsdl-button"
          disabled={readOnly}
          onClick={() => fileInput.current?.click()}
        >
          {t("agsdl.import")}
        </button>
        <button
          className="agsdl-button"
          disabled={!session.source}
          onClick={() => download(session.source, "system.agsdl.json")}
        >
          {t("agsdl.export")}
        </button>
        <button
          className="agsdl-button"
          onClick={() =>
            session.dirty || hasFieldDrafts
              ? setPendingReload(true)
              : void act(() => store().load(target, true))
          }
        >
          {t("agsdl.reload")}
        </button>
        {view === "process" && graphCount > 0 && (
          <select
            aria-label={t("agsdl.graph")}
            value={inspectedGraph}
            onChange={(event) => {
              setGraphIndex(Number(event.target.value));
              setSelected("");
            }}
          >
            {list(doc?.graphs).map((graph, index) => (
              <option key={index} value={index}>
                {text(object(object(graph).definition).id) || `#${index + 1}`}
              </option>
            ))}
          </select>
        )}
        {view === "system" && agents.length > 0 && (
          <select
            aria-label={t("agsdl.inspectAgent")}
            value={focusedAgent ?? "all"}
            onChange={(event) => {
              setSystemScope(event.target.value);
              setSelected("");
            }}
          >
            <option value="all">{t("agsdl.allDeclarations")}</option>
            {agents.map((agent) => (
              <option key={agent.path} value={agent.path}>
                {text(object(agent.value.annotations).title) ||
                  text(object(agent.value.key).id)}
              </option>
            ))}
          </select>
        )}
        {(view === "process" || view === "system") && doc && (
          <select
            aria-label={t("agsdl.add")}
            value=""
            disabled={
              structuredReadOnly || (view === "process" && graphCount === 0)
            }
            onChange={(event) => {
              const kind = event.target.value;
              void act(() => {
                store().edit(
                  target,
                  view === "system"
                    ? addDefinition(session.source, kind)
                    : kind === "invoke"
                      ? addAgent(session.source, inspectedGraph)
                      : addStep(
                          session.source,
                          inspectedGraph,
                          kind as "condition" | "approval" | "end",
                        ),
                  session.version,
                );
                const updated = readDocument(store().sessions[key].source);
                if (view === "system") {
                  setSystemScope("all");
                  setSelected(
                    `/definitions/${list(updated.definitions).length - 1}`,
                  );
                } else {
                  setSelected(
                    `/graphs/${inspectedGraph}/steps/${list(object(list(updated.graphs)[inspectedGraph]).steps).length - 1}`,
                  );
                }
              });
            }}
          >
            <option value="">{t("agsdl.add")}</option>
            {(view === "process"
              ? ["invoke", "condition", "approval", "end"]
              : [
                  "Agent",
                  "Tool",
                  "Instructions",
                  "Skill",
                  "Resource",
                  "Principal",
                  "Interface",
                  "Action",
                  "ControlFlow",
                ]
            ).map((kind) => (
              <option key={kind} value={kind}>
                {t(`agsdl.kind.${kind}`, { defaultValue: kind })}
              </option>
            ))}
          </select>
        )}
      </div>
      {readOnly && (
        <p className="px-3 py-2 text-xs text-muted-foreground">
          {t("agsdl.readOnly")}
        </p>
      )}
      {(error || session.error) && (
        <p role="alert" className="agsdl-error">
          {error || session.error}
        </p>
      )}
      {!session.source ? (
        <div className="agsdl-empty">
          <strong>{t("agsdl.emptyTitle")}</strong>
          <p>{t("agsdl.emptyDescription")}</p>
          <div className="agsdl-example-grid">
            {AGSDL_EXAMPLES.map((kind) => (
              <button
                className="agsdl-button"
                disabled={readOnly}
                key={kind}
                onClick={() =>
                  void act(() =>
                    store().replace(
                      target,
                      createExample(kind as AgsdlExample),
                      {},
                    ),
                  )
                }
              >
                {t(`agsdl.example.${kind}`)}
              </button>
            ))}
          </div>
          <p className="text-xs">{t("agsdl.exampleNote")}</p>
        </div>
      ) : view === "source" ? (
        <div className="agsdl-source">
          <JsonEditor
            draftKey="source"
            label={t("agsdl.documentSource")}
            value={session.source}
            version={session.version}
            readOnly={readOnly}
            onApply={(source, version) =>
              store().replace(target, source, undefined, version)
            }
          />
          <details>
            <summary>{t("agsdl.dependencies")}</summary>
            <p className="text-xs text-muted-foreground my-2">
              {t("agsdl.dependencyNote")}
            </p>
            <select
              value={annexId}
              onChange={(event) => setAnnexId(event.target.value)}
              aria-label={t("agsdl.chooseDependency")}
            >
              <option value="">{t("agsdl.chooseDependency")}</option>
              {list(doc?.dependencies)
                .map(object)
                .map((dep, index) => (
                  <option key={index} value={text(dep.id)}>
                    {text(dep.id)}
                  </option>
                ))}
            </select>
            <button
              className="agsdl-button"
              disabled={readOnly || !annexId}
              onClick={() => annexInput.current?.click()}
            >
              {t("agsdl.attach")}
            </button>
            <input
              ref={annexInput}
              type="file"
              className="hidden"
              accept=".json,.agsdl"
              onChange={(event) => {
                importFile(event.target.files?.[0], true);
                event.target.value = "";
              }}
            />
            {Object.entries(session.annexes).map(([id, source]) => (
              <div className="flex gap-2 items-center my-2" key={id}>
                <span>{id}</span>
                <button
                  className="agsdl-button"
                  onClick={() =>
                    download(source, `${id.replace(/[^a-z0-9_-]/gi, "_")}.json`)
                  }
                >
                  {t("agsdl.export")}
                </button>
                <button
                  className="agsdl-button"
                  disabled={readOnly}
                  onClick={() =>
                    void act(() => {
                      const annexes = { ...session.annexes };
                      delete annexes[id];
                      store().replace(
                        target,
                        session.source,
                        annexes,
                        session.version,
                      );
                    })
                  }
                >
                  {t("agsdl.remove")}
                </button>
              </div>
            ))}
          </details>
        </div>
      ) : !doc ? (
        <div className="agsdl-empty">
          <p role="alert">{parsed.error}</p>
          <button className="agsdl-button" onClick={() => setView("source")}>
            {t("agsdl.source")}
          </button>
        </div>
      ) : view === "configuration" ? (
        <div className="agsdl-source">
          <p className="text-xs text-muted-foreground">
            {t("agsdl.configurationNote")}
          </p>
          {configuration ? (
            <>
              <label className="flex flex-col gap-2">
                {t("agsdl.inspectConfiguration")}
                <select
                  value={inspectedConfig}
                  onChange={(event) =>
                    setConfigIndex(Number(event.target.value))
                  }
                >
                  {configurations.map((config, index) => (
                    <option value={index} key={index}>
                      {text(config.id)}
                    </option>
                  ))}
                </select>
              </label>
              <p className="text-xs">
                {t("agsdl.selectedConfiguration")}:{" "}
                {text(object(doc.runtime).selected) || t("agsdl.none")}
              </p>
              <button
                className="agsdl-button"
                disabled={structuredReadOnly}
                onClick={() =>
                  void act(() =>
                    store().edit(
                      target,
                      [
                        {
                          op: "set",
                          path: "/runtime/selected",
                          valueJson: JSON.stringify(configuration.id),
                        },
                      ],
                      session.version,
                    ),
                  )
                }
              >
                {t("agsdl.selectConfiguration")}
              </button>
              <JsonEditor
                draftKey={`configuration:${inspectedConfig}`}
                key={inspectedConfig}
                label={t("agsdl.configuration")}
                value={sourceAt(
                  session.source,
                  `/runtime/configurations/${inspectedConfig}`,
                )}
                version={session.version}
                readOnly={structuredReadOnly}
                onApply={(value, version) =>
                  store().edit(
                    target,
                    [
                      {
                        op: "set",
                        path: `/runtime/configurations/${inspectedConfig}`,
                        valueJson: value,
                      },
                    ],
                    version,
                  )
                }
              />
            </>
          ) : (
            <>
              <p>{t("agsdl.noConfiguration")}</p>
              <button
                className="agsdl-button"
                onClick={() => setView("source")}
              >
                {t("agsdl.source")}
              </button>
            </>
          )}
        </div>
      ) : (
        <div className="agsdl-body">
          <div className="agsdl-graph-area">
            {projection.nodes.length ? (
              <AgsdlCanvas
                key={`${view}:${inspectedGraph}:${focusedAgent}:${expanded}`}
                {...projection}
                selected={selected}
                problemPaths={problemPaths}
                readOnly={structuredReadOnly}
                onSelect={setSelected}
                onSelectEdge={setSelected}
                onConnect={connect}
              />
            ) : (
              <div className="agsdl-empty">
                {t("agsdl.noGraph")}
                <button
                  className="agsdl-button"
                  onClick={() => setView("system")}
                >
                  {t("agsdl.system")}
                </button>
              </div>
            )}
          </div>
          {selected && (
            <AgsdlInspector
              source={session.source}
              version={session.version}
              path={selected}
              readOnly={structuredReadOnly}
              onSelect={setSelected}
              onEdit={(changes, version) =>
                store().edit(target, changes, version)
              }
            />
          )}
        </div>
      )}
      {hasFieldDrafts && (
        <details className="px-3 py-1 text-xs">
          <summary>{t("agsdl.fieldDrafts")}</summary>
          {Object.entries(session.fieldDrafts)
            .filter(([, draft]) => draft.value !== draft.base)
            .map(([key, draft]) => (
              <div key={key} className="flex gap-2 items-center py-1">
                <code className="break-all">{key}</code>
                <button
                  className="agsdl-button"
                  onClick={() =>
                    store().setFieldDraft(target, key, {
                      ...draft,
                      value: draft.base,
                    })
                  }
                >
                  {t("agsdl.discard")}
                </button>
              </div>
            ))}
        </details>
      )}
      <div className="agsdl-status" aria-live="polite">
        <span>
          {t(
            hasFieldDrafts
              ? "agsdl.fieldDrafts"
              : session.dirty
                ? "agsdl.unsaved"
                : "agsdl.saved",
          )}
        </span>
        <button
          className="agsdl-button"
          onClick={() => setShowDiagnostics(!showDiagnostics)}
        >
          {t("agsdl.diagnostics")} · {findings.length}
        </button>
        <span>{t("agsdl.noExecution")}</span>
      </div>
      {showDiagnostics && (
        <div className="agsdl-diagnostics">
          <div className="p-2 flex flex-wrap gap-2">
            {session.reports.map((report) => (
              <span key={report.operation}>
                {report.operation}: {report.results.at(-1)?.verdict}
              </span>
            ))}
          </div>
          {findings.map((finding, index) => (
            <button
              key={index}
              onClick={() =>
                selectFinding(finding.location.pointer ?? "", finding.input)
              }
            >
              <strong>
                {finding.rule} · {finding.input}
              </strong>{" "}
              {finding.location.pointer}
              <br />
              {finding.details}
            </button>
          ))}
        </div>
      )}
    </div>
  );
  return (
    <AgsdlDraftTarget.Provider value={target}>
      {expanded ? (
        <Dialog
          title={t("agsdl.graph")}
          onClose={() => setExpanded(false)}
          panelClassName="w-[96vw] h-[92vh] max-w-[1600px] overflow-hidden rounded-lg border border-border"
        >
          {content}
        </Dialog>
      ) : (
        content
      )}
      {pendingReload && (
        <Dialog
          title={t("agsdl.discardTitle")}
          onClose={() => setPendingReload(false)}
          panelClassName="max-w-md rounded-lg bg-card border border-border p-5 text-foreground"
        >
          <p>{t("agsdl.discardDescription")}</p>
          <div className="flex gap-2 mt-4">
            <button
              className="agsdl-button"
              onClick={() => setPendingReload(false)}
            >
              {t("agsdl.cancel")}
            </button>
            <button
              className="agsdl-button"
              onClick={() => {
                setPendingReload(false);
                void act(() => store().load(target, true));
              }}
            >
              {t("agsdl.reload")}
            </button>
          </div>
        </Dialog>
      )}
    </AgsdlDraftTarget.Provider>
  );
};
