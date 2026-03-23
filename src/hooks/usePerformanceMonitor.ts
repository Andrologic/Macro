import { useEffect, useRef, useCallback } from 'react';

// =============================================================================
// PERFORMANCE MONITORING HOOK
// =============================================================================

interface PerformanceMetrics {
  // Navigation timing
  timeToFirstByte: number;
  domContentLoaded: number;
  loadComplete: number;
  
  // React render timing
  firstRender: number;
  interactive: number;
  
  // Custom marks
  [key: string]: number;
}

interface PerformanceReport {
  metrics: PerformanceMetrics;
  timestamp: number;
  url: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const PERFORMANCE_STORAGE_KEY = 'macro-performance-metrics';
const MAX_STORED_REPORTS = 50;
let initialReactMountLogged = false;
let initialDomReadyLogged = false;
let initialWindowLoadLogged = false;
let initialReportGenerated = false;
let initialReportScheduled = false;

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get navigation timing metrics
 */
const getNavigationTiming = (): Partial<PerformanceMetrics> => {
  if (typeof window === 'undefined' || !window.performance) {
    return {};
  }

  const navigation = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming;
  
  if (!navigation) {
    return {};
  }

  return {
    timeToFirstByte: navigation.responseStart - navigation.startTime,
    domContentLoaded: navigation.domContentLoadedEventEnd - navigation.startTime,
    loadComplete: navigation.loadEventEnd - navigation.startTime,
  };
};

/**
 * Store performance report
 */
const storeReport = (report: PerformanceReport): void => {
  try {
    const existing = JSON.parse(localStorage.getItem(PERFORMANCE_STORAGE_KEY) || '[]');
    const reports = [report, ...existing].slice(0, MAX_STORED_REPORTS);
    localStorage.setItem(PERFORMANCE_STORAGE_KEY, JSON.stringify(reports));
  } catch (error) {
    console.warn('[PerformanceMonitor] Failed to store report:', error);
  }
};

/**
 * Get stored reports
 */
export const getPerformanceReports = (): PerformanceReport[] => {
  try {
    return JSON.parse(localStorage.getItem(PERFORMANCE_STORAGE_KEY) || '[]');
  } catch {
    return [];
  }
};

/**
 * Clear stored reports
 */
export const clearPerformanceReports = (): void => {
  localStorage.removeItem(PERFORMANCE_STORAGE_KEY);
};

// =============================================================================
// HOOK
// =============================================================================

export function usePerformanceMonitor() {
  const marksRef = useRef<Map<string, number>>(new Map());
  const startTimeRef = useRef<number>(performance.now());

  /**
   * Mark a custom timing point
   */
  const mark = useCallback((name: string): void => {
    const time = performance.now() - startTimeRef.current;
    marksRef.current.set(name, time);
    
    // Also create a performance mark for DevTools
    if (typeof performance !== 'undefined' && performance.mark) {
      performance.mark(`${name}-start`);
    }
    
    console.log(`[Performance] ${name}: ${time.toFixed(2)}ms`);
  }, []);

  /**
   * Measure time between two marks
   */
  const measure = useCallback((name: string, startMark?: string, endMark?: string): number => {
    if (typeof performance !== 'undefined' && performance.measure) {
      try {
        performance.measure(name, startMark, endMark);
        const entries = performance.getEntriesByName(name);
        const lastEntry = entries[entries.length - 1] as PerformanceMeasure;
        return lastEntry?.duration || 0;
      } catch {
        // Fallback to manual calculation
        const start = startMark ? marksRef.current.get(startMark) || 0 : 0;
        const end = endMark ? marksRef.current.get(endMark) || performance.now() - startTimeRef.current : performance.now() - startTimeRef.current;
        return end - start;
      }
    }
    return 0;
  }, []);

  /**
   * Get all metrics
   */
  const getMetrics = useCallback((): PerformanceMetrics => {
    const navigationTiming = getNavigationTiming();
    const customMarks: Record<string, number> = {};
    
    marksRef.current.forEach((value, key) => {
      customMarks[key] = value;
    });

    return {
      ...navigationTiming,
      ...customMarks,
    } as PerformanceMetrics;
  }, []);

  /**
   * Generate and store a performance report
   */
  const generateReport = useCallback((): PerformanceReport => {
    const report: PerformanceReport = {
      metrics: getMetrics(),
      timestamp: Date.now(),
      url: window.location.href,
    };
    
    storeReport(report);
    return report;
  }, [getMetrics]);

  /**
   * Log metrics to console in a formatted table
   */
  const logMetrics = useCallback((): void => {
    const metrics = getMetrics();
    
    console.group('📊 Performance Metrics');
    console.table(metrics);
    console.groupEnd();
  }, [getMetrics]);

  // Auto-mark important milestones
  useEffect(() => {
    let reportTimeoutId: ReturnType<typeof setTimeout> | null = null;

    // Mark when component mounts (React render start)
    if (!initialReactMountLogged) {
      initialReactMountLogged = true;
      mark('react-mount');
    }

    const scheduleInitialReport = () => {
      if (initialReportGenerated || initialReportScheduled) {
        return;
      }

      initialReportScheduled = true;
      reportTimeoutId = setTimeout(() => {
        initialReportScheduled = false;
        if (initialReportGenerated) {
          return;
        }

        initialReportGenerated = true;
        const report = generateReport();
        console.log('[PerformanceMonitor] Report generated:', report);
      }, 100);
    };

    const handleDomReady = () => {
      if (initialDomReadyLogged) {
        return;
      }

      initialDomReadyLogged = true;
      mark('dom-ready');
    };
    const handleWindowLoad = () => {
      if (!initialWindowLoadLogged) {
        initialWindowLoadLogged = true;
        mark('window-load');
      }
      scheduleInitialReport();
    };

    // Mark when DOM is ready
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', handleDomReady);
    } else {
      handleDomReady();
    }

    // Mark when fully loaded
    if (document.readyState !== 'complete') {
      window.addEventListener('load', handleWindowLoad);
    } else {
      handleWindowLoad();
    }

    return () => {
      document.removeEventListener('DOMContentLoaded', handleDomReady);
      window.removeEventListener('load', handleWindowLoad);
      if (reportTimeoutId) {
        clearTimeout(reportTimeoutId);
        initialReportScheduled = false;
      }
    };
  }, [mark, generateReport]);

  return {
    mark,
    measure,
    getMetrics,
    generateReport,
    logMetrics,
  };
}

// =============================================================================
// COMPONENT MOUNT MONITOR
// =============================================================================

/**
 * Hook to monitor individual component render performance
 */
export function useComponentPerformance(componentName: string) {
  const renderCountRef = useRef(0);
  const renderStartRef = useRef(performance.now());

  useEffect(() => {
    renderCountRef.current += 1;
    const renderTime = performance.now() - renderStartRef.current;
    
    if (renderCountRef.current === 1) {
      console.log(`[ComponentPerformance] ${componentName} first render: ${renderTime.toFixed(2)}ms`);
    } else if (renderCountRef.current % 10 === 0) {
      console.log(`[ComponentPerformance] ${componentName} render #${renderCountRef.current}: ${renderTime.toFixed(2)}ms`);
    }

    renderStartRef.current = performance.now();
  });

  return {
    renderCount: renderCountRef.current,
  };
}

export default usePerformanceMonitor;
