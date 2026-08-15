import React from "react";
import ReactDOM from "react-dom/client";
import type { Root } from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { usePerformanceMonitor } from "./hooks/usePerformanceMonitor";
import { initializeI18n } from "./i18n";
import { installFrontendDiagnostics } from "./services/frontendDiagnostics";
import { registerAppStateGetter } from "./services/appStateRuntime";
import { useAppStore } from "./stores/useAppStore";
import { isDevelopmentBuild } from "./utils/devLogger";
import "xterm/css/xterm.css";
import "./index.css";
import "./styles/highlight.css";

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

const appTree = isDevelopmentBuild ? (
  <PerformanceMonitor>
    <App />
  </PerformanceMonitor>
) : (
  <App />
);

// =============================================================================
// APP RENDER
// =============================================================================

const rootElement = document.getElementById("root") as HTMLElement;

type MacroRootWindow = Window & {
  __MACRO_REACT_ROOT__?: Root;
};

// Mark React render start
if (typeof performance !== 'undefined' && performance.mark) {
  performance.mark('react-render-start');
}

installBenignTauriReloadWarningFilter();
installFrontendDiagnostics();
registerAppStateGetter(() => useAppStore.getState());

const renderApp = (): void => {
  const macroWindow = window as MacroRootWindow;
  const root = macroWindow.__MACRO_REACT_ROOT__ ?? ReactDOM.createRoot(rootElement);
  macroWindow.__MACRO_REACT_ROOT__ = root;
  root.render(
    <React.StrictMode>
      <ThemeProvider>
        {appTree}
      </ThemeProvider>
    </React.StrictMode>,
  );
};

void initializeI18n()
  .catch((error) => {
    console.error("Failed to initialize i18n:", error);
  })
  .finally(() => {
    renderApp();
  });
