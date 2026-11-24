import type { SchedulePolicy, ScheduleRepeat, ScheduleTiming } from "../../../services/ipc/architectSchedule";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { selectClass } from "./launchModel";

export interface ScheduleFields {
  firstAt: string;
  repeat: ScheduleRepeat["kind"];
  hours: string;
  weekdays: number[];
  policy: SchedulePolicy;
}

export const initialScheduleFields: ScheduleFields = {
  firstAt: "", repeat: "once", hours: "1", weekdays: [],
  policy: { catchUp: true, allowOverlap: false, alwaysLatest: false },
};

const mondayIndex = (date: Date) => (date.getDay() + 6) % 7;

export function toScheduleTiming(fields: ScheduleFields, now: number): ScheduleTiming | null {
  const first = new Date(fields.firstAt);
  const firstAtMs = first.getTime();
  if (!Number.isFinite(firstAtMs) || firstAtMs <= now || first.getFullYear() > 9999) return null;
  if (fields.repeat === "hourly") {
    const hours = Number(fields.hours);
    if (!Number.isInteger(hours) || hours < 1 || hours > 4_294_967_295) return null;
    return { firstAtMs, repeat: { kind: "hourly", hours } };
  }
  if (fields.repeat === "weekly") {
    return { firstAtMs, repeat: { kind: "weekly", weekdays: [...new Set([mondayIndex(first), ...fields.weekdays])] } };
  }
  return { firstAtMs, repeat: { kind: fields.repeat } };
}

export function LaunchScheduleFields({ value, onChange, editing, sharedFolder, disabled }: {
  value: ScheduleFields;
  onChange: (fields: ScheduleFields) => void;
  editing: boolean;
  sharedFolder: boolean;
  disabled: boolean;
}) {
  const { t, i18n } = useAgsdlTranslation();
  const firstDay = mondayIndex(new Date(value.firstAt));
  const labelDay = new Intl.DateTimeFormat(i18n.resolvedLanguage, { weekday: "short", timeZone: "UTC" });
  const kinds = ["once", "hourly", "daily", "weekly", "monthly"] as const;
  const policies = ["catchUp", "allowOverlap", "alwaysLatest"] as const;
  return <fieldset className="space-y-2 rounded-md border border-border px-3 py-2" disabled={disabled}>
    <legend className="px-1 font-medium">{t("agsdl.schedule.timing")}</legend>
    {!editing && <>
      <div className="flex flex-wrap gap-2">
        <label className="min-w-0 flex-1 space-y-1">
          <span className="block text-muted-foreground">{t("agsdl.schedule.firstAt")}</span>
          <Input type="datetime-local" value={value.firstAt} className="!h-7 text-xs"
            onChange={event => onChange({ ...value, firstAt: event.target.value })} />
        </label>
        <label className="space-y-1">
          <span className="block text-muted-foreground">{t("agsdl.schedule.repeat")}</span>
          <Select value={value.repeat} className={selectClass}
            onChange={event => onChange({ ...value, repeat: event.target.value as ScheduleRepeat["kind"] })}>
            {kinds.map(kind => <option key={kind} value={kind}>{t(`agsdl.schedule.${kind}`)}</option>)}
          </Select>
        </label>
        {value.repeat === "hourly" && <label className="space-y-1">
          <span className="block text-muted-foreground">{t("agsdl.schedule.hours")}</span>
          <Input type="number" min={1} max={4_294_967_295} step={1} value={value.hours} className="!h-7 w-28 text-xs"
            onChange={event => onChange({ ...value, hours: event.target.value })} />
        </label>}
      </div>
      {value.repeat === "weekly" && <fieldset className="flex flex-wrap gap-2">
        <legend className="mb-1 text-muted-foreground">{t("agsdl.schedule.weekdays")}</legend>
        {Array.from({ length: 7 }, (_, day) => <label key={day} className="flex items-center gap-1">
          <input type="checkbox" checked={day === firstDay || value.weekdays.includes(day)} disabled={day === firstDay}
            onChange={event => onChange({ ...value, weekdays: event.target.checked
              ? [...value.weekdays, day] : value.weekdays.filter(item => item !== day) })} />
          {labelDay.format(Date.UTC(2024, 0, day + 1))}
        </label>)}
      </fieldset>}
      {value.repeat === "monthly" && <p className="!m-0 text-muted-foreground">{t("agsdl.schedule.monthlyHint")}</p>}
    </>}
    {policies.map(policy => <label key={policy} className="flex items-start gap-2">
      <input type="checkbox" className="mt-0.5" checked={value.policy[policy]}
        onChange={event => onChange({ ...value, policy: { ...value.policy, [policy]: event.target.checked } })} />
      <span>{t(`agsdl.schedule.${policy}`)}
        {policy === "allowOverlap" && value.policy.allowOverlap && sharedFolder &&
          <span className="block text-amber-500">{t("agsdl.schedule.sharedFolder")}</span>}
      </span>
    </label>)}
  </fieldset>;
}
