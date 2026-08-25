import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { changeLanguage, resolveSupportedLanguage } from '../../../i18n';
import { SUPPORTED_LANGUAGE_METADATA } from '../../../i18n/languages';
import {
    getEmptyProjectOpenSelection,
    loadProjectOpenSettings,
    saveProjectOpenAppPreference,
    type ProjectOpenAction,
    type ProjectOpenAppCatalog,
    type ProjectOpenAppOption,
    type ProjectOpenAppSelection,
} from '../../../services/projectOpeners';
import {
    CHAT_MAX_TURNS_DEFAULT,
    CHAT_MAX_TURNS_DISABLED,
    CHAT_MAX_TURNS_MAX,
    CHAT_MAX_TURNS_MIN,
    type ChatMaxTurnsPreference,
    normalizeChatMaxTurns,
} from '../../../services/chatTurnLimits';
import { loadPreference, PREF_KEYS, savePreference } from '../../../services/preferences';
import { Select } from '../../ui/Select';
import { Input } from '../../ui/Input';
import { Switch } from '../../ui/Switch';
import { ToolSecuritySettingsSection } from './ToolSecuritySettingsSection';
import { SettingsSectionHeader } from '../SettingsSectionHeader';
import { notify } from '../../ui/toastService';
import { UpdateChannelSettings } from './UpdateChannelSettings';

export const GeneralView: React.FC = () => {
    const { t, i18n } = useTranslation();
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
    const [chatMaxTurns, setChatMaxTurns] = useState(CHAT_MAX_TURNS_DEFAULT);
    const [chatMaxTurnsDraft, setChatMaxTurnsDraft] = useState(
        String(CHAT_MAX_TURNS_DEFAULT)
    );
    const chatMaxTurnsTouchedRef = useRef(false);
    const chatMaxTurnsSaveRevisionRef = useRef(0);
    const projectOpenSaveRevisionsRef = useRef<Record<ProjectOpenAction, number>>({
        editor: 0,
        terminal: 0,
        files: 0,
    });
    const [isChatMaxTurnsEnabled, setIsChatMaxTurnsEnabled] = useState(true);

    const reportSaveFailure = (error: unknown) => {
        notify.error(t('settings.configuration.saveFailed', 'Could not save configuration'), {
            description: error instanceof Error ? error.message : String(error),
        });
    };

    const persistChatMaxTurns = async (
        value: ChatMaxTurnsPreference,
        previous: { enabled: boolean; maxTurns: number; draft: string }
    ) => {
        const revision = ++chatMaxTurnsSaveRevisionRef.current;
        try {
            await savePreference(PREF_KEYS.CHAT_MAX_TURNS, value);
        } catch (error) {
            if (chatMaxTurnsSaveRevisionRef.current === revision) {
                setIsChatMaxTurnsEnabled(previous.enabled);
                setChatMaxTurns(previous.maxTurns);
                setChatMaxTurnsDraft(previous.draft);
            }
            reportSaveFailure(error);
        }
    };

    const persistProjectOpenApp = async (
        action: ProjectOpenAction,
        nextValue: string,
        previousValue: string
    ) => {
        const revision = projectOpenSaveRevisionsRef.current[action] + 1;
        projectOpenSaveRevisionsRef.current[action] = revision;
        try {
            await saveProjectOpenAppPreference(action, nextValue);
        } catch (error) {
            if (projectOpenSaveRevisionsRef.current[action] === revision) {
                setSelectedProjectOpenApps((current) => ({
                    ...current,
                    [action]: previousValue,
                }));
            }
            reportSaveFailure(error);
        }
    };

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

    useEffect(() => {
        let cancelled = false;

        void loadPreference<ChatMaxTurnsPreference>(PREF_KEYS.CHAT_MAX_TURNS).then((maxTurns) => {
            if (cancelled || chatMaxTurnsTouchedRef.current) {
                return;
            }

            const normalizedMaxTurns = normalizeChatMaxTurns(maxTurns);
            if (normalizedMaxTurns === CHAT_MAX_TURNS_DISABLED) {
                setIsChatMaxTurnsEnabled(false);
                setChatMaxTurnsDraft(String(CHAT_MAX_TURNS_DEFAULT));
                return;
            }

            const committedMaxTurns = normalizedMaxTurns ?? CHAT_MAX_TURNS_DEFAULT;
            setIsChatMaxTurnsEnabled(true);
            setChatMaxTurns(committedMaxTurns);
            setChatMaxTurnsDraft(String(committedMaxTurns));
        });

        return () => {
            cancelled = true;
        };
    }, []);

    const commitChatMaxTurnsDraft = () => {
        chatMaxTurnsTouchedRef.current = true;
        if (!isChatMaxTurnsEnabled) {
            setChatMaxTurnsDraft(String(chatMaxTurns));
            return;
        }

        const trimmedValue = chatMaxTurnsDraft.trim();
        if (!trimmedValue) {
            setChatMaxTurnsDraft(String(chatMaxTurns));
            return;
        }

        const numericValue = Number(trimmedValue);
        if (!Number.isFinite(numericValue)) {
            setChatMaxTurnsDraft(String(chatMaxTurns));
            return;
        }

        const nextValue = normalizeChatMaxTurns(numericValue) ?? CHAT_MAX_TURNS_DEFAULT;
        const previous = {
            enabled: isChatMaxTurnsEnabled,
            maxTurns: chatMaxTurns,
            draft: String(chatMaxTurns),
        };
        setChatMaxTurns(nextValue);
        setChatMaxTurnsDraft(String(nextValue));
        if (nextValue !== chatMaxTurns) {
            void persistChatMaxTurns(nextValue, previous);
        }
    };

    const updateChatMaxTurnsEnabled = (enabled: boolean) => {
        chatMaxTurnsTouchedRef.current = true;
        const previous = {
            enabled: isChatMaxTurnsEnabled,
            maxTurns: chatMaxTurns,
            draft: chatMaxTurnsDraft,
        };
        setIsChatMaxTurnsEnabled(enabled);
        if (enabled) {
            const nextValue = normalizeChatMaxTurns(chatMaxTurns);
            if (nextValue === CHAT_MAX_TURNS_DISABLED) {
                setChatMaxTurns(CHAT_MAX_TURNS_DEFAULT);
                setChatMaxTurnsDraft(String(CHAT_MAX_TURNS_DEFAULT));
                void persistChatMaxTurns(CHAT_MAX_TURNS_DEFAULT, previous);
                return;
            }

            setChatMaxTurns(nextValue);
            setChatMaxTurnsDraft(String(nextValue));
            void persistChatMaxTurns(nextValue, previous);
            return;
        }

        setChatMaxTurnsDraft(String(chatMaxTurns));
        void persistChatMaxTurns(CHAT_MAX_TURNS_DISABLED, previous);
    };

    const handleChatMaxTurnsKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
        if (event.key !== 'Enter') {
            return;
        }
        event.preventDefault();
        commitChatMaxTurnsDraft();
    };

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
                    const previousValue = selectedProjectOpenApps[action];
                    setSelectedProjectOpenApps((current) => ({
                        ...current,
                        [action]: nextValue,
                    }));
                    void persistProjectOpenApp(action, nextValue, previousValue);
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
                <SettingsSectionHeader title={t('settings.language_region', 'Language & Region')} />

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
                <SettingsSectionHeader title={t('settings.application', 'Application')} />

                <ToolSecuritySettingsSection />

                <div className="space-y-4 bg-card/40 p-4 rounded-xl border border-border/50">
                    <UpdateChannelSettings />
                    <div className="border-t border-border/50" />
                    <div className="flex flex-col gap-3">
                        <div className="space-y-1">
                            <label htmlFor="chat-max-turns-enabled" className="text-sm font-medium text-foreground">
                                {t('settings.agentLoop.limitEnabledLabel', 'Limit agent turns')}
                            </label>
                            <p className="text-xs text-muted-foreground">
                                {t(
                                    'settings.agentLoop.limitEnabledDescription',
                                    'Stop long tool loops by forcing a final answer after a configured number of cycles.'
                                )}
                            </p>
                        </div>
                        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                            <div className="flex items-center gap-3">
                                <Switch
                                    id="chat-max-turns-enabled"
                                    checked={isChatMaxTurnsEnabled}
                                    onCheckedChange={updateChatMaxTurnsEnabled}
                                />
                                <span className="text-sm text-muted-foreground">
                                    {isChatMaxTurnsEnabled
                                        ? t('settings.agentLoop.limitEnabledOn', 'Enabled')
                                        : t('settings.agentLoop.limitEnabledOff', 'Disabled')}
                                </span>
                            </div>
                            <div className="flex items-center gap-3">
                                <label htmlFor="chat-max-turns" className="text-sm font-medium text-foreground">
                                    {t('settings.agentLoop.maxTurnsLabel', 'Max agent turns')}
                                </label>
                                <Input
                                    id="chat-max-turns"
                                    type="number"
                                    min={CHAT_MAX_TURNS_MIN}
                                    max={CHAT_MAX_TURNS_MAX}
                                    step={1}
                                    value={chatMaxTurnsDraft}
                                    disabled={!isChatMaxTurnsEnabled}
                                    onChange={(event) => {
                                        chatMaxTurnsTouchedRef.current = true;
                                        setChatMaxTurnsDraft(event.target.value);
                                    }}
                                    onBlur={commitChatMaxTurnsDraft}
                                    onKeyDown={handleChatMaxTurnsKeyDown}
                                    className="w-28"
                                    aria-label={t('settings.agentLoop.maxTurnsLabel', 'Max agent turns')}
                                />
                            </div>
                        </div>
                    </div>
                    <div className="space-y-4">
                        <div className="space-y-1">
                            <label className="text-sm font-medium text-foreground">
                                {t('settings.openSubprojectsWith', 'Open projects with')}
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
                                    'Used when clicking the code editor quick action for a project.'
                                )
                            )}
                            {renderProjectOpenSelect(
                                'terminal',
                                t('settings.terminalApp', 'Terminal'),
                                t(
                                    'settings.terminalAppDesc',
                                    'Used when clicking the terminal quick action for a project.'
                                )
                            )}
                            {renderProjectOpenSelect(
                                'files',
                                t('settings.fileExplorerApp', 'File explorer'),
                                t(
                                    'settings.fileExplorerAppDesc',
                                    'Used when clicking the file explorer quick action for a project.'
                                )
                            )}
                        </div>
                    </div>
                </div>
            </section>
        </div>
    );
};
