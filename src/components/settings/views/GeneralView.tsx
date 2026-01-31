import React from 'react';
import { useTranslation } from 'react-i18next';
// @ts-ignore
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from '../../ui/Select';
import { Switch } from '../../ui/Switch';

export const GeneralView: React.FC = () => {
    const { t, i18n } = useTranslation();
    
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
                </div>
            </section>
        </div>
    );
};
