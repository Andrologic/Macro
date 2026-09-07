import React, { useState } from "react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import type { AgsdlChange } from "../../types/agsdl";
import {
  keyId,
  list,
  object,
  pointerPart,
  readDocument,
  sourceAt,
  text,
} from "../../services/agsdl/document";
import { renameStep } from "../../services/agsdl/editing";
import { successors } from "../../services/agsdl/projection";

import { JsonEditor } from "./AgsdlFieldEditor";
export { JsonEditor, AgsdlDraftTarget } from "./AgsdlFieldEditor";

export interface InspectorProps {
  source: string;
  version: string;
  path: string;
  readOnly: boolean;
  onEdit: (changes: AgsdlChange[], version?: string) => void;
  onSelect: (path: string) => void;
}

export const AgsdlInspector: React.FC<InspectorProps> = ({
  source,
  version,
  path,
  readOnly,
  onEdit,
  onSelect,
}) => {
  const { t } = useAgsdlTranslation();
  const [error, setError] = useState("");
  const attempt = (action: () => void) => {
    try {
      action();
      setError("");
    } catch (error) {
      setError(String(error));
    }
  };
  const doc = readDocument(source);
  let raw: string;
  try {
    raw = sourceAt(source, path);
  } catch {
    return <div className="agsdl-inspector">{t("agsdl.selectElement")}</div>;
  }
  const item = object(JSON.parse(raw));
  const stepMatch = /^\/graphs\/(\d+)\/steps\/(\d+)$/.exec(path);
  const graph = stepMatch ? object(list(doc.graphs)[Number(stepMatch[1])]) : {};
  const setValue = (field: string, value: unknown) =>
    onEdit(
      [
        {
          op: "set",
          path: `${path}/${field}`,
          valueJson: JSON.stringify(value),
        },
      ],
      version,
    );
  const definitions = list(doc.definitions).map(object);
  return (
    <div className="agsdl-inspector">
      <div className="flex items-center justify-between gap-2">
        <strong>{t("agsdl.properties")}</strong>
        <button className="agsdl-button" onClick={() => onSelect("")}>
          {t("agsdl.close")}
        </button>
      </div>
      {error && (
        <p role="alert" className="agsdl-error">
          {error}
        </p>
      )}
      <code className="text-xs text-muted-foreground break-all">
        {path || "/"}
      </code>
      {(path === "/root" || /^\/definitions\/\d+$/.test(path)) && (
        <>
          <JsonEditor
            draftKey={`${path}:title`}
            multiline={false}
            version={version}
            label={t("agsdl.title")}
            value={
              text(object(item.annotations).title) || text(object(item.key).id)
            }
            readOnly={readOnly}
            onApply={(value, expectedVersion) =>
              onEdit(
                [
                  {
                    op: "set",
                    path:
                      item.annotations && typeof item.annotations === "object"
                        ? `${path}/annotations/title`
                        : `${path}/annotations`,
                    valueJson: JSON.stringify(
                      item.annotations && typeof item.annotations === "object"
                        ? value
                        : { title: value },
                    ),
                  },
                ],
                expectedVersion,
              )
            }
          />
          <div className="text-muted-foreground">{text(item.kind)}</div>
          {item.kind === "Agent" && (
            <div className="flex flex-wrap gap-1 mt-2">
              {list(doc.relations)
                .map(object)
                .filter(
                  (relation) => keyId(relation.source) === keyId(item.key),
                )
                .map((relation, index) => {
                  const targetIndex = definitions.findIndex(
                    (def) => keyId(def.key) === keyId(relation.target),
                  );
                  return (
                    <button
                      className="agsdl-button"
                      key={index}
                      disabled={targetIndex < 0}
                      onClick={() => onSelect(`/definitions/${targetIndex}`)}
                    >
                      {text(relation.relation)}:{" "}
                      {text(object(relation.target).id) ||
                        text(object(object(relation.target).key).id)}
                    </button>
                  );
                })}
            </div>
          )}
          {item.kind === "Instructions" && (
            <JsonEditor
              draftKey={`${path}:body`}
              label={t("agsdl.instructions")}
              value={text(object(item.payload).body)}
              version={version}
              readOnly={readOnly}
              onApply={(value, expected) =>
                onEdit(
                  [
                    {
                      op: "set",
                      path: `${path}/payload/body`,
                      valueJson: JSON.stringify(value),
                    },
                  ],
                  expected,
                )
              }
            />
          )}
        </>
      )}
      {stepMatch && (
        <>
          <JsonEditor
            draftKey={`${path}:id`}
            multiline={false}
            version={version}
            label={t("agsdl.identifier")}
            value={text(item.id)}
            readOnly={readOnly}
            onApply={(name, expectedVersion) =>
              onEdit(
                renameStep(
                  source,
                  Number(stepMatch[1]),
                  Number(stepMatch[2]),
                  name,
                ),
                expectedVersion,
              )
            }
          />
          {item.kind === "invoke" && (
            <button
              className="agsdl-button"
              onClick={() => {
                const index = definitions.findIndex(
                  (def) => keyId(def.key) === keyId(item.agent),
                );
                if (index >= 0) onSelect(`/definitions/${index}`);
              }}
            >
              {t("agsdl.openAgent")}: {text(object(item.agent).id)}
            </button>
          )}
          {[
            ...successors(item),
            ...(item.kind === "approval" ? ["call"] : []),
          ].map((field) => (
            <label key={field}>
              {t(`agsdl.edge.${field}`, { defaultValue: field })}
              <select
                disabled={readOnly}
                value={text(item[field])}
                onChange={(event) =>
                  attempt(() =>
                    setValue(pointerPart(field), event.target.value),
                  )
                }
              >
                <option value="">{t("agsdl.notConnected")}</option>
                {list(graph.steps)
                  .map(object)
                  .filter((step) => field !== "call" || step.kind === "invoke")
                  .map((step, index) => (
                    <option key={index} value={text(step.id)}>
                      {text(step.id)}
                    </option>
                  ))}
              </select>
            </label>
          ))}
          {graph.entry !== item.id && (
            <button
              className="agsdl-button"
              disabled={readOnly}
              onClick={() =>
                attempt(() =>
                  onEdit(
                    [
                      {
                        op: "set",
                        path: `/graphs/${stepMatch[1]}/entry`,
                        valueJson: JSON.stringify(item.id),
                      },
                    ],
                    version,
                  ),
                )
              }
            >
              {t("agsdl.makeEntry")}
            </button>
          )}
        </>
      )}
      <details
        className="mt-3"
        open={
          !stepMatch && item.kind !== "Agent" && item.kind !== "Instructions"
        }
      >
        <summary>{t("agsdl.fullProperties")}</summary>
        <JsonEditor
          draftKey={`${path}:json`}
          key={path}
          label={t("agsdl.jsonProperties")}
          value={raw}
          version={version}
          readOnly={readOnly}
          onApply={(value, expectedVersion) =>
            onEdit([{ op: "set", path, valueJson: value }], expectedVersion)
          }
        />
      </details>
      {path && path !== "/root" && (
        <button
          className="agsdl-button mt-3"
          disabled={readOnly}
          onClick={() =>
            attempt(() => {
              onEdit([{ op: "remove", path }], version);
              onSelect("");
            })
          }
        >
          {t("agsdl.remove")}
        </button>
      )}
    </div>
  );
};
