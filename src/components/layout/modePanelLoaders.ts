// Compatibility entry point; the shell composes its views in workspaceViews.
export * from './panelLoader';
export { modePanelLoaders, hasModePanel, preloadModePanels, resetModePanelLoader } from '../../composition/workspaceViews';
export type { ModePanelConfiguration } from '../../composition/workspaceViews';
