import React from 'react';
import { useTranslation } from 'react-i18next';
// @ts-ignore
import { Select } from '../../ui/Select';
import { Switch } from '../../ui/Switch';
import { useAppStore } from '../../../stores/useAppStore';
import type { ProjectSwitchPolicy } from '../../../services/localProjectContext';

export const GeneralView: React.FC = () => {
    const { t, i18n } = useTranslation();
    const projectSwitchPolicy = useAppStore((state) => state.projectSwitchPolicy);
    const setProjectSwitchPolicy = useAppStore((state) => state.setProjectSwitchPolicy);
    const metadataAutoPush = useAppStore((state) => state.metadataAutoPush);
    const setMetadataAutoPush = useAppStore((state) => state.setMetadataAutoPush);
    const implementExecutionMode = useAppStore((state) => state.implementExecutionMode);
    const setImplementExecutionMode = useAppStore((state) => state.setImplementExecutionMode);
    
    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300">
            <section className="space-y-4">
                <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
                    {t('settings.language_region') || 'Language & Region'}
                </h4>
                
                <div className="grid grid-cols-1 gap-6 bg-card/40 p-4 rounded-xl border border-border/50">
                    <div className="flex items-center justify-between">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">{t('settings.language') || 'Language'}</label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.language_desc') || 'Select your preferred language interface'}
                            </p>
                        </div>
                        <div className="w-[180px]">
                            <Select value={i18n.language} onChange={(e: any) => i18n.changeLanguage(e.target.value)}>
                                <option value="en">English</option>
                                <option value="fr">Français</option>
                                <option value="es">Español</option>
                                <option value="de">Deutsch</option>
                                <option value="ja">日本語</option>
                                <option value="ko">한국어</option>
                            </Select>
                        </div>
                    </div>
                </div>
            </section>

             <section className="space-y-4">
                <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
                    {t('settings.application') || 'Application'}
                </h4>
                
                <div className="space-y-4 bg-card/40 p-4 rounded-xl border border-border/50">
                    <div className="flex items-center justify-between">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">{t('settings.sound_effects') || 'Sound Effects'}</label>
                            <p className="text-xs text-muted-foreground">{t('settings.sound_effects_desc') || 'Play sounds on task completion or errors'}</p>
                        </div>
                        <Switch checked={true} onCheckedChange={() => {}} disabled />
                    </div>
                    <div className="h-px bg-border/50" />
                     <div className="flex items-center justify-between">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">{t('settings.desktop_notifications') || 'Desktop Notifications'}</label>
                            <p className="text-xs text-muted-foreground">{t('settings.desktop_notifications_desc') || 'Show native desktop notifications for important events'}</p>
                        </div>
                        <Switch checked={false} onCheckedChange={() => {}} disabled />
                    </div>
                    <div className="h-px bg-border/50" />
                    <div className="flex items-center justify-between">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">{t('settings.analytics') || 'Analytics'}</label>
                            <p className="text-xs text-muted-foreground">{t('settings.analytics_desc') || 'Share anonymous usage data to help improve Macro'}</p>
                        </div>
                         <Switch checked={false} onCheckedChange={() => {}} />
                    </div>
                    <div className="h-px bg-border/50" />
                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.projectContextPolicy') || 'Project context memory'}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.projectContextPolicyDesc') || 'Control whether Architect/Implement context is restored per project when switching.'}
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
                                    {t('settings.projectContextPolicyResume') || 'Resume per project'}
                                </option>
                                <option value="reset_on_switch">
                                    {t('settings.projectContextPolicyReset') || 'Reset on project switch'}
                                </option>
                            </Select>
                        </div>
                    </div>
                    <div className="h-px bg-border/50" />
                    <div className="flex items-center justify-between">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.metadataAutoPush') || 'Auto-push @macro metadata'}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.metadataAutoPushDesc') || 'Automatically push @macro branch after metadata commits created at stream completion.'}
                            </p>
                        </div>
                        <Switch checked={metadataAutoPush} onCheckedChange={setMetadataAutoPush} />
                    </div>
                    <div className="h-px bg-border/50" />
                    <div className="flex items-center justify-between gap-4">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.autoLaunchAfterValidation') || 'Lancer auto après validation'}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t('settings.autoLaunchAfterValidationDesc') || "Lance l'exécution des tâches directement après la validation du plan."}
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
