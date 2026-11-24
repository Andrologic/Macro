import { useState, type FormEvent } from "react";
import { launchFieldTypes, MAX_LAUNCH_FIELDS, validLaunchFields, type LaunchField, type LaunchFields } from "../../services/agsdl/launchFields";
import { useAgsdlTranslation } from "./useAgsdlTranslation";

export function ProjectLaunchFields({ fields, disabled, onSave }: {
  fields: LaunchField[];
  disabled: boolean;
  onSave: (schema: LaunchFields | null) => void;
}) {
  const { t } = useAgsdlTranslation();
  const [edits, setEdits] = useState<LaunchField[]>();
  const current = edits ?? fields;
  const valid = validLaunchFields(current);
  const dirty = !!edits && JSON.stringify(edits) !== JSON.stringify(fields);
  const edit = (index: number, patch: Partial<LaunchField>) =>
    setEdits(current.map((field, position) => position === index ? { ...field, ...patch } : field));
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (disabled || !dirty || !valid) return;
    onSave(current.length ? { version: "macro-launch-fields/1", fields: current } : null);
  };

  return <form onSubmit={submit} className="space-y-2" aria-label={t("agsdl.launch.fields.title")}>
    <h4 className="m-0 text-[11px] font-medium text-muted-foreground">{t("agsdl.launch.fields.title")}</h4>
    <p className="!m-0 text-muted-foreground">{t("agsdl.launch.fields.authorHelp")}</p>
    {current.map((field, index) => <fieldset key={index} disabled={disabled} className="rounded-md border border-border px-2 pb-2">
      <legend className="px-1 text-muted-foreground">{field.label || t("agsdl.launch.fields.newField")}</legend>
      <div className="grid grid-cols-2 gap-x-2">
        <label className="agsdl-edit-field">{t("agsdl.launch.fields.label")}
          <input value={field.label} onChange={event => edit(index, { label: event.target.value })} />
        </label>
        <label className="agsdl-edit-field">{t("agsdl.launch.fields.key")}
          <input value={field.key} onChange={event => edit(index, { key: event.target.value })} />
        </label>
        <label className="agsdl-edit-field">{t("agsdl.launch.fields.type")}
          <select value={field.type} onChange={event => edit(index, { type: event.target.value as LaunchField["type"] })}>
            {launchFieldTypes.map(type => <option key={type} value={type}>{t(`agsdl.launch.fields.types.${type}`)}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2 self-end pb-1">
          <input type="checkbox" className="size-3.5 accent-primary" checked={field.required}
            onChange={event => edit(index, { required: event.target.checked })} />
          {t("agsdl.launch.fields.required")}
        </label>
      </div>
      <button type="button" className="agsdl-link mt-1" onClick={() => setEdits(current.filter((_, position) => position !== index))}>
        {t("agsdl.remove")}
      </button>
    </fieldset>)}
    {edits && !valid && <p role="alert" className="!m-0 text-red-500">{t("agsdl.launch.fields.definitionHelp")}</p>}
    <div className="flex gap-3">
      <button type="button" className="agsdl-link" disabled={disabled || current.length >= MAX_LAUNCH_FIELDS}
        onClick={() => setEdits([...current, { key: "", label: "", type: "text", required: true }])}>
        {t("agsdl.launch.fields.add")}
      </button>
      <button type="submit" className="agsdl-link" disabled={disabled || !dirty || !valid}>{t("agsdl.save")}</button>
    </div>
  </form>;
}
