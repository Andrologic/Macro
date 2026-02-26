import React, { useState, useEffect } from 'react';
import { loadPreference, savePreference, PREF_KEYS } from '../../../services/preferences';
import { Icon } from '../../ui/Icon';
import { cn } from '../../../utils/cn';

export const PromptsView: React.FC = () => {
    const [architectPrompt, setArchitectPrompt] = useState('');
    const [implementPrompt, setImplementPrompt] = useState('');
    const [chatPrompt, setChatPrompt] = useState('');
    const [debugPrompt, setDebugPrompt] = useState('');

    const [isSaving, setIsSaving] = useState(false);
    const [saveSuccess, setSaveSuccess] = useState(false);

    useEffect(() => {
        const loadPrompts = async () => {
            const pArchitect = await loadPreference<string>(PREF_KEYS.PROMPT_ARCHITECT);
            const pImplement = await loadPreference<string>(PREF_KEYS.PROMPT_IMPLEMENT);
            const pChat = await loadPreference<string>(PREF_KEYS.PROMPT_CHAT);
            const pDebug = await loadPreference<string>(PREF_KEYS.PROMPT_DEBUG);

            setArchitectPrompt(pArchitect);
            setImplementPrompt(pImplement);
            setChatPrompt(pChat);
            setDebugPrompt(pDebug);
        };
        loadPrompts();
    }, []);

    const handleSave = async () => {
        setIsSaving(true);
        setSaveSuccess(false);

        await savePreference(PREF_KEYS.PROMPT_ARCHITECT, architectPrompt);
        await savePreference(PREF_KEYS.PROMPT_IMPLEMENT, implementPrompt);
        await savePreference(PREF_KEYS.PROMPT_CHAT, chatPrompt);
        await savePreference(PREF_KEYS.PROMPT_DEBUG, debugPrompt);

        setIsSaving(false);
        setSaveSuccess(true);

        setTimeout(() => setSaveSuccess(false), 3000);
    };

    const handleReset = async () => {
        // Basic defaults
        setArchitectPrompt("You are the Architect AI. Manage isolated plans in `.macro` metadata. Each plan has its own conversation, needs, and strategy. Follow strict Git Flow: each plan integrates on plan/<plan-slug> from develop, while execution branches are feature/<plan-slug>/<feature-slug> merged into plan/<plan-slug> in dependency order. Use add_need to capture requirements. Do not call generate_plan automatically: discuss and refine needs first, then call generate_plan only when the user explicitly asks to generate or regenerate strategy. Plan names/slugs are unique forever and cannot be reused. Use get_strategy/update_strategy/delete_strategy for strategy changes. Use create_plan/list_plans/get_plan/update_plan/delete_plan/restore_plan/set_active_plan for plan management.");
        setImplementPrompt("You are the Implementer. Follow the tasks to implement the specific feature.");
        setChatPrompt("You are a helpful AI assistant.");
        setDebugPrompt("You are the Debugger. Use workspace tools to investigate and fix issues.");
    };

    const renderTextarea = (label: string, value: string, onChange: (val: string) => void) => (
        <div className="space-y-2">
            <label className="text-sm font-medium text-foreground">{label}</label>
            <textarea
                value={value}
                onChange={(e) => onChange(e.target.value)}
                className="w-full min-h-[120px] p-3 rounded-lg bg-background border border-border/50 text-sm focus:outline-none focus:ring-1 focus:ring-primary focus:border-primary resize-y font-mono"
                spellCheck={false}
            />
        </div>
    );

    return (
        <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-300 pb-10">
            <div className="flex items-center justify-between mb-4">
                <div>
                    <h4 className="text-sm font-medium text-primary uppercase tracking-wider">
                        System Prompts
                    </h4>
                    <p className="text-xs text-muted-foreground mt-1">
                        Customize the system instructions the AI uses for each mode.
                    </p>
                </div>

                <div className="flex items-center gap-2">
                    <button
                        onClick={handleReset}
                        className="px-3 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    >
                        Reset Defaults
                    </button>
                    <button
                        onClick={handleSave}
                        disabled={isSaving}
                        className={cn(
                            "px-4 py-1.5 rounded-md text-xs font-medium transition-all duration-200 flex items-center gap-2",
                            saveSuccess
                                ? "bg-emerald-500/20 text-emerald-500"
                                : "bg-primary text-primary-foreground hover:bg-primary/90"
                        )}
                    >
                        {isSaving ? (
                            <Icon name="loader" size={14} className="animate-spin" />
                        ) : saveSuccess ? (
                            <Icon name="check" size={14} />
                        ) : (
                            <Icon name="download" size={14} />
                        )}
                        {saveSuccess ? 'Saved' : 'Save Changes'}
                    </button>
                </div>
            </div>

            <div className="space-y-6 bg-card/40 p-5 rounded-xl border border-border/50">
                {renderTextarea('Architect Mode', architectPrompt, setArchitectPrompt)}
                <div className="h-px bg-border/50" />
                {renderTextarea('Implement Mode', implementPrompt, setImplementPrompt)}
                <div className="h-px bg-border/50" />
                {renderTextarea('Chat Mode', chatPrompt, setChatPrompt)}
                <div className="h-px bg-border/50" />
                {renderTextarea('Debug Mode', debugPrompt, setDebugPrompt)}
            </div>
        </div>
    );
};
