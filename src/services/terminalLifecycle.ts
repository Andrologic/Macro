/** Rendering resources only. Detaching or stopping never closes a native PTY. */
export interface TerminalLifecyclePort {
  disposeTab(tabId: string): void;
  disposeAll(): void;
}
