import { architectSchedule, type ScheduleAction, type ScheduledLaunch } from "../../services/ipc/architectSchedule";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { notify } from "../ui/toastService";
import { OperateMenuItem, useOperateFormat } from "./OperateColumnParts";
import { OperateChip, OperateRow } from "./OperateRow";

export function OperateScheduleRow({ schedule, attention = false, open, refresh }: {
  schedule: ScheduledLaunch;
  attention?: boolean;
  open: (schedule: ScheduledLaunch, number: number) => void;
  refresh: () => void;
}) {
  const { t } = useAgsdlTranslation();
  const { full } = useOperateFormat();
  const { id, systemLabel, version, latestNumber, nextAtMs, issueCode, issueAtMs, policy, suspended, starting } = schedule;
  const hasUpdate = latestNumber > version.number;
  const configure = () => open(schedule, policy.alwaysLatest ? latestNumber : version.number);
  const update = () => open(schedule, latestNumber);
  const act = (action: ScheduleAction) => {
    void architectSchedule.act(id, action).then(refresh, () => {
      notify.error(t("agsdl.schedule.actionFailed"));
    });
  };
  const detail = attention
    ? (issueAtMs === null ? "" : full(issueAtMs))
    : starting && !suspended ? t("agsdl.launch.starting")
    : nextAtMs === null ? t("agsdl.schedule.done") : t(suspended ? "agsdl.schedule.suspended" : "agsdl.schedule.nextAt", { date: full(nextAtMs) });
  const reason = issueCode === "SCHEDULE_OVERLAP" ? t("agsdl.schedule.overlapSkipped")
    : issueCode === "SCHEDULE_INTERRUPTED" ? t("agsdl.schedule.interrupted") : t("agsdl.schedule.failed");
  const note = attention ? reason
    : hasUpdate ? t("agsdl.schedule.newVersion", { number: latestNumber }) : t("agsdl.library.version", { number: version.number });
  return <OperateRow icon={attention ? "triangle-alert" : suspended ? "pause" : "clock"}
    tone={attention ? "amber" : "muted"} title={systemLabel}
    detail={<span className="block truncate text-[10px]" title={detail}>{detail}</span>}
    chip={<OperateChip label={note} tone={attention || hasUpdate ? "amber" : "muted"} title={attention ? issueCode ?? note : note} />}
    openLabel={t("agsdl.schedule.configure")} menuLabel={t("agsdl.schedule.configure")} onOpen={configure}
    quickAction={hasUpdate && !attention ? { icon: "arrow-up", label: t("agsdl.schedule.update"), onClick: update } : undefined}
    renderMenu={close => <>
      {hasUpdate && <OperateMenuItem icon="arrow-up" onClick={() => { close(); update(); }}>{t("agsdl.schedule.update")}</OperateMenuItem>}
      {(nextAtMs !== null || starting) && <OperateMenuItem icon={suspended ? "play" : "pause"}
        onClick={() => { close(); act({ kind: suspended ? "resume" : "suspend" }); }}>
        {t(suspended ? "agsdl.schedule.resume" : "agsdl.schedule.suspend")}
      </OperateMenuItem>}
      {issueAtMs !== null && <OperateMenuItem icon="check" onClick={() => { close(); act({ kind: "dismiss", atMs: issueAtMs }); }}>
        {t("agsdl.schedule.dismiss")}
      </OperateMenuItem>}
      <OperateMenuItem icon="trash" danger onClick={() => { close(); act({ kind: "delete" }); }}>{t("agsdl.schedule.remove")}</OperateMenuItem>
    </>} />;
}
