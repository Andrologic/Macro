import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { ThemeProvider } from "./components/theme/ThemeProvider";
import { usePerformanceMonitor } from "./hooks/usePerformanceMonitor";
import "./i18n"; // Initialize i18n before React renders
import "./index.css";
import "./styles/highlight.css";

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

// Mark React render start
if (typeof performance !== 'undefined' && performance.mark) {
  performance.mark('react-render-start');
}

ReactDOM.createRoot(rootElement).render(
  <React.StrictMode>
    <ThemeProvider>
      <PerformanceMonitor>
        <App />
      </PerformanceMonitor>
    </ThemeProvider>
  </React.StrictMode>,
);
