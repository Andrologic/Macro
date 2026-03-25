import React from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, resolveSupportedLanguage } from '../../../i18n';
import { SUPPORTED_LANGUAGE_METADATA } from '../../../i18n/languages';
import type { ProjectSwitchPolicy } from '../../../services/localProjectContext';
import { useAppStore } from '../../../stores/useAppStore';
// @ts-ignore
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';

export const GeneralView: React.FC = () => {
    const { t, i18n } = useTranslation();
    const projectSwitchPolicy = useAppStore((state) => state.projectSwitchPolicy);
    const setProjectSwitchPolicy = useAppStore((state) => state.setProjectSwitchPolicy);
    const metadataAutoPush = useAppStore((state) => state.metadataAutoPush);
    const setMetadataAutoPush = useAppStore((state) => state.setMetadataAutoPush);
    const implementExecutionMode = useAppStore((state) => state.implementExecutionMode);
    const setImplementExecutionMode = useAppStore((state) => state.setImplementExecutionMode);
    const selectedLanguage = resolveSupportedLanguage(i18n.resolvedLanguage || i18n.language);

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
                                        {language.flag} {language.nativeName}
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
                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.autoLaunchAfterValidation', 'Auto-launch after validation')}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.autoLaunchAfterValidationDesc', 'Start task execution directly after plan validation.')}
                            </p>
                        </div>
                        <Switch
                            checked={implementExecutionMode === 'full_auto'}
                            onCheckedChange={(checked) => setImplementExecutionMode(checked ? 'full_auto' : 'semi_auto')}
                        />
                    </div>
                </div>
            </section>
        </div>
    );
};
