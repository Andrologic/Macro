import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, resolveSupportedLanguage } from '../../../i18n';
import { SUPPORTED_LANGUAGE_METADATA } from '../../../i18n/languages';
import type { ProjectSwitchPolicy } from '../../../services/localProjectContext';
import {
    getEmptyProjectOpenSelection,
    loadProjectOpenSettings,
    saveProjectOpenAppPreference,
    type ProjectOpenAction,
    type ProjectOpenAppCatalog,
    type ProjectOpenAppOption,
    type ProjectOpenAppSelection,
} from '../../../services/projectOpeners';
import { useAppStore } from '../../../stores/useAppStore';
// @ts-ignore
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { ToolSecuritySettingsSection } from './ToolSecuritySettingsSection';

export const GeneralView: React.FC = () => {
    const { t, i18n } = useTranslation();
    const projectSwitchPolicy = useAppStore((state) => state.projectSwitchPolicy);
    const setProjectSwitchPolicy = useAppStore((state) => state.setProjectSwitchPolicy);
    const metadataAutoPush = useAppStore((state) => state.metadataAutoPush);
    const setMetadataAutoPush = useAppStore((state) => state.setMetadataAutoPush);
    const selectedLanguage = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);
    const [projectOpenApps, setProjectOpenApps] = useState<ProjectOpenAppCatalog>({
        editor: [],
        terminal: [],
        files: [],
    });
    const [selectedProjectOpenApps, setSelectedProjectOpenApps] = useState<ProjectOpenAppSelection>({
        ...getEmptyProjectOpenSelection(),
    });
    const [isLoadingProjectOpenApps, setIsLoadingProjectOpenApps] = useState(true);

    useEffect(() => {
        let cancelled = false;

        const loadApps = async () => {
            try {
                const settings = await loadProjectOpenSettings();
                if (cancelled) {
                    return;
                }

                setProjectOpenApps(settings.appsByAction);
                setSelectedProjectOpenApps(settings.selectedAppIdsByAction);
            } finally {
                if (!cancelled) {
                    setIsLoadingProjectOpenApps(false);
                }
            }
        };

        void loadApps();

        return () => {
            cancelled = true;
        };
    }, []);

    const renderProjectOpenOptions = (apps: ProjectOpenAppOption[]) => {
        const noneOption = apps.find((app) => app.kind === 'none');
        const builtinOptions = apps.filter((app) => app.kind === 'builtin');
        const detectedOptions = apps.filter((app) => app.kind === 'detected');

        return (
            <>
                {noneOption && (
                    <option key={noneOption.id} value={noneOption.id}>
                        {t('settings.projectOpenNone', 'Do nothing')}
                    </option>
                )}
                {detectedOptions.length > 0 && (
                    <optgroup label={t('settings.projectOpenDetectedGroup', 'Detected apps')}>
                        {detectedOptions.map((app) => (
                            <option key={app.id} value={app.id}>
                                {app.label}
                            </option>
                        ))}
                    </optgroup>
                )}
                {builtinOptions.length > 0 && (
                    <optgroup label={t('settings.projectOpenBuiltinGroup', 'Built-in options')}>
                        {builtinOptions.map((app) => (
                            <option key={app.id} value={app.id}>
                                {app.label}
                            </option>
                        ))}
                    </optgroup>
                )}
            </>
        );
    };

    const renderProjectOpenSelect = (
        action: ProjectOpenAction,
        label: string,
        description: string
    ) => (
        <div className="space-y-1.5">
            <label className="text-xs font-medium text-foreground">{label}</label>
            <Select
                value={selectedProjectOpenApps[action]}
                disabled={isLoadingProjectOpenApps}
                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                    const nextValue = event.target.value;
                    setSelectedProjectOpenApps((current) => ({
                        ...current,
                        [action]: nextValue,
                    }));
                    void saveProjectOpenAppPreference(action, nextValue);
                }}
            >
                {renderProjectOpenOptions(projectOpenApps[action])}
            </Select>
            <p className="text-[11px] text-muted-foreground">{description}</p>
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <section className="space-y-4">
                <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
                    {t('settings.language_region', 'Language & Region')}
                </h4>

                <div className="grid grid-cols-1 gap-6 bg-card/40 p-4 rounded-xl border border-border/50">
                    <div className="flex items-center justify-between">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">{t('settings.language', 'Language')}</label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.language_desc', 'Select your preferred language interface')}
                            </p>
                        </div>
                        <div className="w-[220px]">
                            <Select
                                value={selectedLanguage}
                                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                                    void changeLanguage(resolveSupportedLanguage(e.target.value))
                                }
                            >
                                {SUPPORTED_LANGUAGE_METADATA.map((language) => (
                                    <option key={language.code} value={language.code}>
                                        {language.nativeName}
                                    </option>
                                ))}
                            </Select>
                        </div>
                    </div>
                </div>
            </section>

             <section className="space-y-4">
                <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
                    {t('settings.application', 'Application')}
                </h4>

                <ToolSecuritySettingsSection />

                <div className="space-y-4 bg-card/40 p-4 rounded-xl border border-border/50">
                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.projectContextPolicy', 'Project context memory')}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.projectContextPolicyDesc', 'Control whether Architect/Implement context is restored per project when switching.')}
                            </p>
                        </div>
                        <div className="w-[250px]">
                            <Select
                                value={projectSwitchPolicy}
                                onChange={(event: React.ChangeEvent<HTMLSelectElement>) => {
                                    const nextPolicy = (event.target.value === 'reset_on_switch'
                                        ? 'reset_on_switch'
                                        : 'resume_per_project') as ProjectSwitchPolicy;
                                    void setProjectSwitchPolicy(nextPolicy);
                                }}
                            >
                                <option value="resume_per_project">
                                    {t('settings.projectContextPolicyResume', 'Resume per project')}
                                </option>
                                <option value="reset_on_switch">
                                    {t('settings.projectContextPolicyReset', 'Reset on project switch')}
                                </option>
                            </Select>
                        </div>
                    </div>
                    <div className="h-px bg-border/50" />
                    <div className="flex items-center justify-between">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.metadataAutoPush', 'Auto-push @macro metadata')}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.metadataAutoPushDesc', 'Automatically push the @macro branch after metadata commits created at stream completion.')}
                            </p>
                        </div>
                        <Switch checked={metadataAutoPush} onCheckedChange={setMetadataAutoPush} />
                    </div>
                    <div className="h-px bg-border/50" />
                    <div className="space-y-4">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.openSubprojectsWith', 'Open subprojects with')}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t(
                                    'settings.openSubprojectsWithDesc',
                                    'Choose which detected app each quick action should use in the project modal.'
                                )}
                            </p>
                        </div>
                        <div className="grid grid-cols-1 gap-4">
                            {renderProjectOpenSelect(
                                'editor',
                                t('settings.codeEditorApp', 'Code editor'),
                                t(
                                    'settings.codeEditorAppDesc',
                                    'Used when clicking the code editor quick action for a subproject.'
                                )
                            )}
                            {renderProjectOpenSelect(
                                'terminal',
                                t('settings.terminalApp', 'Terminal'),
                                t(
                                    'settings.terminalAppDesc',
                                    'Used when clicking the terminal quick action for a subproject.'
                                )
                            )}
                            {renderProjectOpenSelect(
                                'files',
                                t('settings.fileExplorerApp', 'File explorer'),
                                t(
                                    'settings.fileExplorerAppDesc',
                                    'Used when clicking the file explorer quick action for a subproject.'
                                )
                            )}
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};
