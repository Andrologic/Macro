import type { LaunchPreview } from "../../../services/ipc/architectLaunch";
import { DisclosureSummary } from "../../agsdl/DisclosureSummary";
import { useAgsdlTranslation } from "../../agsdl/useAgsdlTranslation";
import { Icon } from "../../ui/Icon";
import { flowReach } from "./launchModel";

/**
 * A system can pass every check and still start nothing: its flow may never hand work to an agent.
 * This says so before launching. It is a warning, never a blocker: a flow can also be made of direct calls.
 */
export function LaunchReach({ preview }: { preview: LaunchPreview }) {
  const { t } = useAgsdlTranslation();
  const { declared, unreached } = flowReach(preview.permissions.agents);
  if (!unreached.length) return null;
  const none = unreached.length === declared.length;
  const title = none ? t("agsdl.launch.reach.noneTitle") : t("agsdl.launch.reach.someTitle", { count: unreached.length });
  return <section aria-label={title} className="space-y-1 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2">
    <h3 className="!m-0 flex items-center gap-2 text-xs font-medium text-amber-500">
      <Icon name="triangle-alert" size={13} aria-hidden="true" />
      {title}
    </h3>
    <p className="!m-0 !mt-1 break-words">{none ? t("agsdl.launch.reach.none") : t("agsdl.launch.reach.some", { names: unreached.join(", ") })}</p>
    {none && <details className="agsdl-details !mt-1 !border-0 !pt-0">
      <DisclosureSummary>{t("agsdl.viewer.technicalDetails")}</DisclosureSummary>
      <p className="!m-0 break-words font-mono text-[11px]">{unreached.join(", ")}</p>
    </details>}
  </section>;
}
