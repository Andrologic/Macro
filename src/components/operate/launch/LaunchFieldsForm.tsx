import { useId, type ChangeEvent } from "react";
import { launchFieldValue, type LaunchFields } from "../../../services/agsdl/launchFields";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import { selectClass } from "./launchModel";

export function LaunchFieldsForm({ schema, hint, values, disabled, onChange }: {
  schema: LaunchFields;
  hint: string | null;
  values: ReadonlyMap<string, string>;
  disabled: boolean;
  onChange: (key: string, value: string) => void;
}) {
  const { t } = useAgsdlTranslation();
  const formId = useId();

  return <fieldset className="space-y-2" disabled={disabled}>
    <legend className="font-medium">{t("agsdl.launch.fields.title")}</legend>
    {hint && <p className="!m-0 whitespace-pre-wrap break-words text-[11px] text-muted-foreground">
      {t("agsdl.launch.authorHint", { hint })}</p>}
    {schema.fields.map(field => {
      const raw = values.get(field.key) ?? "";
      const invalid = /[^\p{White_Space}]/u.test(raw) && launchFieldValue(field, raw) === undefined;
      const props = {
        value: raw, "aria-required": field.required, "aria-invalid": invalid || undefined,
        onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) =>
          onChange(field.key, event.target.value),
      };
      const id = `${formId}-${field.key}`;
      return <div key={field.key} className="space-y-1">
        <label htmlFor={id} className="block">{field.label}
          {field.required && <span aria-hidden="true"> *</span>}</label>
        {field.type === "boolean" ? <Select id={id} {...props} className={selectClass}>
          <option value="">{t("agsdl.launch.fields.chooseBoolean")}</option>
          <option value="true">{t("agsdl.launch.fields.yes")}</option>
          <option value="false">{t("agsdl.launch.fields.no")}</option>
        </Select> : field.type === "number" ? <Input id={id} {...props} type="number" step="any" className="h-7 text-xs" />
          : <Textarea id={id} {...props} rows={2} className="text-xs" />}
        {invalid && <p role="alert" className="!m-0 text-red-500">{t("agsdl.launch.fields.invalidValues")}</p>}
      </div>;
    })}
  </fieldset>;
}
