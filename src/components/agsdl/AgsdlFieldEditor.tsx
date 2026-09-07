import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useAgsdlTranslation } from "./useAgsdlTranslation";
import {
  agsdlSessionKey,
  useAgsdlStore,
  type AgsdlTarget,
} from "../../stores/useAgsdlStore";

export const AgsdlDraftTarget = createContext<AgsdlTarget | null>(null);

/** Field buffers belong to the plan session, so switching panels cannot discard typing. */
export const JsonEditor: React.FC<{
  draftKey: string;
  multiline?: boolean;
  value: string;
  version: string;
  label: string;
  readOnly: boolean;
  onApply: (value: string, version: string) => void;
}> = ({
  draftKey,
  value,
  version,
  label,
  readOnly,
  onApply,
  multiline = true,
}) => {
  const { t } = useAgsdlTranslation();
  const target = useContext(AgsdlDraftTarget);
  const stored = useAgsdlStore((state) =>
    target
      ? state.sessions[agsdlSessionKey(target)]?.fieldDrafts[draftKey]
      : undefined,
  );
  const [error, setError] = useState("");
  const draft = stored ?? { value, base: value, version };
  const dirty = draft.value !== draft.base;
  const setDraft = useCallback(
    (next: typeof draft) => {
      if (target)
        useAgsdlStore.getState().setFieldDraft(target, draftKey, next);
    },
    [target, draftKey],
  );
  useEffect(() => {
    if (
      stored &&
      !dirty &&
      (stored.base !== value || stored.version !== version)
    )
      setDraft({ value, base: value, version });
  }, [value, version, stored, dirty, setDraft]);
  return (
    <div>
      <label>
        {label}
        {multiline ? (
          <textarea
            className="agsdl-json"
            value={draft.value}
            readOnly={readOnly}
            spellCheck={false}
            onChange={(event) =>
              setDraft({ ...draft, value: event.target.value })
            }
          />
        ) : (
          <input
            value={draft.value}
            readOnly={readOnly}
            onChange={(event) =>
              setDraft({ ...draft, value: event.target.value })
            }
          />
        )}
      </label>
      {!readOnly && (
        <div className="flex gap-2">
          <button
            className="agsdl-button"
            disabled={!dirty}
            onClick={() => {
              try {
                onApply(draft.value, draft.version);
                setDraft({ value: draft.value, base: draft.value, version });
                setError("");
              } catch (error) {
                setError(String(error));
              }
            }}
          >
            {t("agsdl.apply")}
          </button>
          <button
            className="agsdl-button"
            disabled={!dirty}
            onClick={() => {
              setDraft({ value, base: value, version });
              setError("");
            }}
          >
            {t("agsdl.discard")}
          </button>
        </div>
      )}
      {error && (
        <p role="alert" className="agsdl-error">
          {error}
        </p>
      )}
    </div>
  );
};
