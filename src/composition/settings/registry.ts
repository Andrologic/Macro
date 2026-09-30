import type { ComponentType } from 'react';
import { ContributionRegistry, type Contribution } from '../../domains/shell/contributionRegistry';
import type { IconName } from '../../components/ui/Icon';
import type { SettingsTab } from '../../domains/shell/settings';

export interface SettingsContext {
  readonly settingsOpen: boolean;
}

interface SettingsEntry extends Contribution<SettingsContext> {
  readonly id: SettingsTab;
  readonly icon: IconName;
  readonly labelKey: string;
  readonly label: string;
  readonly descriptionKey: string;
  readonly description?: string;

}

export type SettingsContribution = SettingsEntry & (
  | { readonly component: ComponentType; readonly load?: never }
  | { readonly load: () => Promise<{ default: ComponentType }>; readonly component?: never }
);

export const settingsRegistry = new ContributionRegistry<SettingsContribution, SettingsContext>();

settingsRegistry.register({
  id: 'general', owner: 'shell.settings', order: 0, icon: 'settings',
  labelKey: 'settings.general', label: 'General',
  descriptionKey: 'settings.desc.general',
  load: () => import('../../components/settings/views/GeneralView').then((module) => ({ default: module.GeneralView })),
});
settingsRegistry.register({
  id: 'notifications', owner: 'shell.settings', order: 1, icon: 'bell',
  labelKey: 'settings.notifications', label: 'Notifications',
  descriptionKey: 'settings.desc.notifications',
  description: 'Configure in-app and desktop notification delivery',
  load: () => import('../../components/settings/views/NotificationsView').then((module) => ({ default: module.NotificationsView })),
});
settingsRegistry.register({
  id: 'appearance', owner: 'shell.settings', order: 2, icon: 'palette',
  labelKey: 'settings.appearance', label: 'Appearance',
  descriptionKey: 'settings.desc.appearance',
  load: () => import('../../components/settings/views/AppearanceView').then((module) => ({ default: module.AppearanceView })),
});
settingsRegistry.register({
  id: 'providers', owner: 'shell.settings', order: 3, icon: 'server',
  labelKey: 'settings.providers', label: 'AI Providers',
  descriptionKey: 'settings.desc.providers',
  load: () => import('../../components/settings/views/ai/ProvidersSettings').then((module) => ({ default: module.ProvidersSettings })),
});
settingsRegistry.register({
  id: 'models', owner: 'shell.settings', order: 4, icon: 'cpu',
  labelKey: 'settings.models', label: 'AI Models',
  descriptionKey: 'settings.desc.models',
  load: () => import('../../components/settings/views/ai/ModelsSettings').then((module) => ({ default: module.ModelsSettings })),
});
settingsRegistry.register({
  id: 'speech', owner: 'shell.settings', order: 5, icon: 'mic',
  labelKey: 'settings.speech', label: 'Dictation',
  descriptionKey: 'settings.desc.speech',
  description: 'Configure microphone dictation and speech-to-text providers',
  load: () => import('../../components/settings/views/ai/SpeechSettings').then((module) => ({ default: module.SpeechSettings })),
});
settingsRegistry.register({
  id: 'tools', owner: 'shell.settings', order: 6, icon: 'tool',
  labelKey: 'settings.tools', label: 'Tools & MCP',
  descriptionKey: 'settings.desc.tools',
  load: () => import('../../components/settings/views/ToolsView').then((module) => ({ default: module.ToolsView })),
});
settingsRegistry.register({
  id: 'skills', owner: 'shell.settings', order: 7, icon: 'sparkles',
  labelKey: 'settings.skills', label: 'Skills',
  descriptionKey: 'settings.desc.skills',
  load: () => import('../../components/settings/views/SkillsView').then((module) => ({ default: module.SkillsView })),
});
settingsRegistry.register({
  id: 'prompts', owner: 'shell.settings', order: 8, icon: 'message-square',
  labelKey: 'settings.prompts', label: 'System Prompts',
  descriptionKey: 'settings.desc.prompts',
  load: () => import('../../components/settings/views/PromptsView').then((module) => ({ default: module.PromptsView })),
});
settingsRegistry.register({
  id: 'architect', owner: 'shell.settings', order: 9, icon: 'git-branch',
  labelKey: 'settings.architect', label: 'Git workflow',
  descriptionKey: 'settings.desc.architect',
  load: () => import('../../components/settings/views/ArchitectGitFlowView').then((module) => ({ default: module.ArchitectGitFlowView })),
});
settingsRegistry.register({
  id: 'shortcuts', owner: 'shell.settings', order: 10, icon: 'zap',
  labelKey: 'settings.shortcuts', label: 'Shortcuts',
  descriptionKey: 'settings.desc.shortcuts',
  load: () => import('../../components/settings/views/ShortcutsView').then((module) => ({ default: module.ShortcutsView })),
});
settingsRegistry.register({
  id: 'diagnostics', owner: 'shell.settings', order: 11, icon: 'file-text',
  labelKey: 'settings.diagnostics', label: 'Diagnostics',
  descriptionKey: 'settings.desc.diagnostics',
  load: () => import('../../components/settings/views/DiagnosticsView').then((module) => ({ default: module.DiagnosticsView })),
});
