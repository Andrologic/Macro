import { startGitCacheComposition } from './composition/gitCacheComposition';
import { getPageLifecycleSignal } from './utils/pageLifecycle';
import { createApplicationStartup, type ApplicationStartup } from './services/applicationStartup';
import { createTerminalComposition } from './composition/terminalComposition';
import { createLifecycleScope, type LifecycleScope } from './services/lifecycleScope';
import { startNotificationComposition } from './composition/notificationComposition';
import { startPlansComposition } from './composition/plansComposition';
import { providers, tools } from './composition/domainAdapters';
import { BackupStartupRecovery } from './components/settings/views/BackupRecoveryStatus';
import { restoreBackupBrowserState } from "./services/localBackup";
import React from "react";
import ReactDOM from "react-dom/client";
import type { Root } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { usePerformanceMonitor } from "./hooks/usePerformanceMonitor";
import { initializeI18n } from "./i18n";
import { installFrontendDiagnostics } from "./services/frontendDiagnostics";
import { registerAppStateGetter } from "./services/appStateRuntime";
import { refreshWebSearchSettings } from "./services/webSearchSettings";
import { installConfigRuntimeEffects } from "./services/configRuntimeEffects";
import { useAppStore } from "./stores/useAppStore";
import { initializeConfigRuntime, stopConfigRuntime } from "./stores/useConfigStore";
import { isDevelopmentBuild } from "./utils/devLogger";
import "xterm/css/xterm.css";
import "./index.css";
import "./styles/highlight.css";

const PersistenceHealthNotifications = React.lazy(() => import("./components/notifications/PersistenceHealthNotifications").then(module => ({ default: module.PersistenceHealthNotifications })));

const installBenignTauriReloadWarningFilter = (): void => {
  if (!import.meta.env.DEV || typeof window === "undefined") {
    return;
  }

  type ConsoleMethod = (...args: unknown[]) => void;
  type MacroWindow = Window & {
    __MACRO_TAURI_WARNING_FILTER_INSTALLED__?: boolean;
  };

  const macroWindow = window as MacroWindow;
  if (macroWindow.__MACRO_TAURI_WARNING_FILTER_INSTALLED__) {
    return;
  }

  const tauriReloadWarningPattern =
    /^\[TAURI\] Couldn't find callback id \d+\. This might happen when the app is reloaded while Rust is running an asynchronous operation\.$/;

  const wrapConsoleMethod = (originalMethod: ConsoleMethod): ConsoleMethod => {
    return (...args: unknown[]) => {
      if (typeof args[0] === "string" && tauriReloadWarningPattern.test(args[0])) {
        return;
      }

      originalMethod(...args);
    };
  };

  console.warn = wrapConsoleMethod(console.warn.bind(console));
  console.error = wrapConsoleMethod(console.error.bind(console));
  macroWindow.__MACRO_TAURI_WARNING_FILTER_INSTALLED__ = true;
};

// =============================================================================
// PERFORMANCE MONITORING WRAPPER
// =============================================================================

const PerformanceMonitor: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  usePerformanceMonitor();
  return <>{children}</>;
};

// =============================================================================
// APP RENDER
// =============================================================================

const rootElement = document.getElementById("root") as HTMLElement;

type MacroRootWindow = Window & {
  __MACRO_REACT_ROOT__?: Root;
  __MACRO_APPLICATION__?: ApplicationStartup;
  __MACRO_APPLICATION_GENERATION__?: number;
};

// Mark React render start
if (typeof performance !== 'undefined' && performance.mark) {
  performance.mark('react-render-start');
}

installBenignTauriReloadWarningFilter();
const renderApp = (application: LifecycleScope): void => {
  const appTree = isDevelopmentBuild
    ? <PerformanceMonitor><App application={application} /></PerformanceMonitor>
    : <App application={application} />;
  const macroWindow = window as MacroRootWindow;
  const root = macroWindow.__MACRO_REACT_ROOT__ ?? ReactDOM.createRoot(rootElement);
  macroWindow.__MACRO_REACT_ROOT__ = root;
  root.render(
    <React.StrictMode key={generation}>
      <ThemeProvider>
        <React.Suspense fallback={null}><PersistenceHealthNotifications /></React.Suspense>
        {appTree}
      </ThemeProvider>
    </React.StrictMode>,
  );
};

const macroWindow = window as MacroRootWindow;
const previousRetirement = macroWindow.__MACRO_APPLICATION__?.stop() ?? Promise.resolve();
const generation = (macroWindow.__MACRO_APPLICATION_GENERATION__ ?? 0) + 1;
macroWindow.__MACRO_APPLICATION_GENERATION__ = generation;
const application = createApplicationStartup({
  install: (owner) => {
    owner.own(installFrontendDiagnostics());
    const ports = createLifecycleScope();
    try {
      ports.own(registerAppStateGetter(() => useAppStore.getState()));
      ports.own(startPlansComposition());
      owner.own(startNotificationComposition());
      owner.own(startGitCacheComposition());
      const terminal = createTerminalComposition();
      owner.own(() => { void owner.track(terminal.stop()); });
      owner.own(() => { void owner.track(stopConfigRuntime()); });
      owner.own(() => macroWindow.__MACRO_REACT_ROOT__?.render(null));
      const stopOnPageHide = () => {
        void application.stop().catch((error) => console.error('Application cleanup failed:', error));
      };
      const shutdown = getPageLifecycleSignal();
      shutdown.addEventListener('abort', stopOnPageHide, { once: true });
      owner.own(() => shutdown.removeEventListener('abort', stopOnPageHide));
      if (shutdown.aborted) stopOnPageHide();
      return () => ports.stop();
    } catch (error) {
      ports.stop();
      throw error;
    }
  },
  restore: restoreBackupBrowserState,
  initializeConfiguration: initializeConfigRuntime,
  initializeLanguage: initializeI18n,
  initializeSearch: refreshWebSearchSettings,
  installEffects: (owner) => {
    const stop = installConfigRuntimeEffects({ providers, tools }, owner);
    return () => { void owner.track(stop()); };
  },
  render: renderApp,
  renderRecovery: (error) => {
    const root = macroWindow.__MACRO_REACT_ROOT__ ?? ReactDOM.createRoot(rootElement);
    macroWindow.__MACRO_REACT_ROOT__ = root;
    root.render(<BackupStartupRecovery error={error} />);
  },
  reload: () => window.location.reload(),
  report: (error) => console.error('Failed to initialize Macro runtime:', error),
});
macroWindow.__MACRO_APPLICATION__ = application;
void application.start(previousRetirement).catch((error) => console.error('Application startup failed:', error));
if (import.meta.hot) {
  import.meta.hot.dispose(() => {
    void application.stop().catch((error) => console.error('Application cleanup failed:', error));
  });
}
