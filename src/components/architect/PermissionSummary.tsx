import { KeyRound } from "lucide-react";
import type { ReactNode } from "react";
import { summarizePermissions, type Capability, type PermissionSource } from "../../services/agsdl/permissionSummary";
import { useAgsdlTranslation } from "../agsdl/useAgsdlTranslation";
import { Icon, type IconName } from "../ui/Icon";

export type PermissionSummarySection = "permissions" | "engines" | "prepare";

const capabilityIcon: Record<Capability["id"], IconName> = {
  readFiles: "file-text", readOutside: "folder-open", writeFiles: "edit", writeFolders: "folder", writeAnywhere: "hard-drive",
  runCommands: "terminal", runCommand: "terminal", network: "globe", useTool: "tool",
};
const engineNames: Record<string, string> = { codex: "Codex", "claude-code": "Claude Code" };

/**
 * What a system will be able to do, and what to prepare before it runs.
 * Read from the typed preview, so the import dialog and the launch consent step say the same thing.
 */
export function PermissionSummary({ source, sections = ["permissions", "engines", "prepare"], className }: {
  source: PermissionSource;
  sections?: readonly PermissionSummarySection[];
  className?: string;
}) {
  const { t } = useAgsdlTranslation();
  const model = summarizePermissions(source);
  const capabilityText = ({ id, subject, remote }: Capability) => id === "useTool"
    ? t(remote ? "agsdl.architect.permissions.useRemoteTool" : "agsdl.architect.permissions.useTool", { name: subject })
    : t(`agsdl.architect.permissions.cap.${id}`, { subject });
  const prepare: ReactNode[] = [];
  if (model.secrets.some(secret => secret.requested)) prepare.push(<li key="secrets" className="space-y-0.5">
    {model.secrets.filter(secret => secret.requested).map(secret => <Line key={`${secret.server}/${secret.name}`} icon={<KeyRound size={13} />}>
      {t("agsdl.architect.permissions.secret", { name: secret.name, server: secret.server })}
    </Line>)}
    <p className="!m-0 pl-5 text-[11px] text-muted-foreground">{t("agsdl.architect.permissions.secretHint")}</p>
  </li>);
  if (model.programs.length) prepare.push(<li key="programs" className="space-y-0.5">
    <Line icon={<Icon name="cpu" size={13} />}>{t("agsdl.architect.permissions.programs", { programs: model.programs.join(", "), count: model.programs.length })}</Line>
    <p className="!m-0 pl-5 text-[11px] text-muted-foreground">{t("agsdl.architect.permissions.programsHint")}</p>
  </li>);
  if (model.externalContent) prepare.push(<li key="external">
    <Line icon={<Icon name="triangle-alert" size={13} className="text-amber-500" />}>{t("agsdl.architect.permissions.external", { count: model.externalContent })}</Line>
  </li>);
  if (model.launchBlockers) prepare.push(<li key="blockers">
    <Line icon={<Icon name="triangle-alert" size={13} className="text-amber-500" />}>{t("agsdl.architect.permissions.launchBlockers", { count: model.launchBlockers })}</Line>
  </li>);

  return <div className={className ?? "space-y-3"} data-permission-summary>
    {sections.includes("permissions") && <section aria-label={t("agsdl.architect.permissions.title")}>
      <Heading>{t("agsdl.architect.permissions.title")}</Heading>
      {model.capabilities.length ? <ul className="space-y-1">{model.capabilities.map(capability => <li key={`${capability.id}:${capability.subject ?? ""}`}>
        <Line icon={<Icon name={capability.elevated ? "triangle-alert" : capabilityIcon[capability.id]} size={13}
          className={capability.elevated ? "text-amber-500" : "text-muted-foreground"} />}>
          {capability.elevated && <span className="sr-only">{t("agsdl.architect.permissions.attention")} </span>}
          {capabilityText(capability)}
        </Line>
      </li>)}</ul> : <p className="!m-0 text-muted-foreground">{t("agsdl.architect.permissions.none")}</p>}
    </section>}
    {sections.includes("engines") && model.engines.length > 0 && <section aria-label={t("agsdl.architect.permissions.engines")}>
      <Heading>{t("agsdl.architect.permissions.engines")}</Heading>
      <p className="!m-0">{model.engines.map(engine => engine.model
        ? t("agsdl.architect.permissions.engineModel", { engine: engineNames[engine.harness] ?? engine.harness, model: engine.model })
        : engineNames[engine.harness] ?? engine.harness).join(" · ")}</p>
      <p className="!m-0 text-[11px] text-muted-foreground">{t("agsdl.architect.permissions.enginesHint")}</p>
    </section>}
    {sections.includes("prepare") && <section aria-label={t("agsdl.architect.permissions.prepare")}>
      <Heading>{t("agsdl.architect.permissions.prepare")}</Heading>
      {prepare.length ? <ul className="space-y-1.5">{prepare}</ul> : <p className="!m-0 text-muted-foreground">{t("agsdl.architect.permissions.prepareNothing")}</p>}
    </section>}
  </div>;
}

const Heading = ({ children }: { children: ReactNode }) => <h4 className="mb-1 text-[11px] font-medium text-muted-foreground">{children}</h4>;
const Line = ({ icon, children }: { icon: ReactNode; children: ReactNode }) =>
  <div className="flex items-start gap-2"><span className="mt-0.5 shrink-0" aria-hidden="true">{icon}</span><span className="min-w-0 break-words">{children}</span></div>;
