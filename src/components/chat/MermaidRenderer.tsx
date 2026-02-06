import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import mermaid from 'mermaid';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { useTheme } from '../theme/ThemeProvider';

interface MermaidRendererProps {
  code: string;
  blockKey: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/**
 * Lighten a hex color by a given amount (0-1).
 */
const lighten = (hex: string, amount: number): string => {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.min(255, ((num >> 16) & 0xff) + Math.round(255 * amount));
  const g = Math.min(255, ((num >> 8) & 0xff) + Math.round(255 * amount));
  const b = Math.min(255, (num & 0xff) + Math.round(255 * amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};

/**
 * Darken a hex color by a given amount (0-1).
 */
const darken = (hex: string, amount: number): string => {
  const num = parseInt(hex.replace('#', ''), 16);
  const r = Math.max(0, ((num >> 16) & 0xff) - Math.round(255 * amount));
  const g = Math.max(0, ((num >> 8) & 0xff) - Math.round(255 * amount));
  const b = Math.max(0, (num & 0xff) - Math.round(255 * amount));
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
};

const enhanceSvgSizing = (svgMarkup: string): string => {
  if (!svgMarkup.includes('<svg')) return svgMarkup;
  let processed = svgMarkup.replace(
    /width="[^"]*"/gi,
    'style="max-width: 100%; max-height: 100%; width: auto; height: auto;"'
  );
  processed = processed.replace(/height="[^"]*"/gi, '');
  processed = processed.replace('<svg', '<svg class="mermaid-svg"');
  return processed;
};

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({ code, blockKey }) => {
  const { t } = useTranslation();
  const { theme, isDark } = useTheme();

  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isRendering, setIsRendering] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showCodeInline, setShowCodeInline] = useState(false);
  const [showCodeExpanded, setShowCodeExpanded] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [scale, setScale] = useState(1);
  const [expandedScale, setExpandedScale] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [expandedOffset, setExpandedOffset] = useState({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [isExpandedPanning, setIsExpandedPanning] = useState(false);
  const panStartRef = useRef({ x: 0, y: 0 });
  const panOriginRef = useRef({ x: 0, y: 0 });

  const renderIdRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);
  const renderCountRef = useRef(0);
  const bindFunctionsRef = useRef<((element: Element) => void) | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const expandedContainerRef = useRef<HTMLDivElement>(null);
  const pendingSinceRef = useRef<number | null>(null);
  const pendingTimeoutRef = useRef<number | null>(null);

  // Build a stable key from the theme colors object so useMemo recalculates on any theme change
  const themeKey = useMemo(() => JSON.stringify(theme.colors) + theme.type, [theme]);

  const mermaidConfig = useMemo(() => {
    const c = theme.colors;

    // Node fill: use a tinted version of the background so nodes are distinct
    // but text inside remains readable
    const nodeFill = isDark ? lighten(c.background, 0.08) : darken(c.background, 0.05);
    const nodeFill2 = isDark ? lighten(c.background, 0.12) : darken(c.background, 0.08);

    return {
      startOnLoad: false,
      securityLevel: 'loose' as const,
      theme: 'base' as const,
      darkMode: isDark,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Monaco, Inconsolata, monospace',
      fontSize: 14,
      themeVariables: {
        // -- Backgrounds --
        background: 'transparent',
        mainBkg: nodeFill,
        secondBkg: nodeFill2,
        tertiaryColor: isDark ? lighten(c.background, 0.15) : darken(c.background, 0.1),

        // -- Primary node (most flowchart nodes) --
        primaryColor: nodeFill,
        primaryTextColor: c.foreground,
        primaryBorderColor: c.border,

        // -- Secondary / tertiary --
        secondaryColor: nodeFill2,
        secondaryTextColor: c.foreground,
        secondaryBorderColor: c.border,
        tertiaryTextColor: c.foreground,
        tertiaryBorderColor: c.border,

        // -- Lines --
        lineColor: c.mutedForeground,

        // -- Notes --
        noteBkgColor: isDark ? lighten(c.background, 0.06) : darken(c.background, 0.04),
        noteTextColor: c.foreground,
        noteBorderColor: c.border,

        // -- Labels --
        labelBackground: c.background,
        labelTextColor: c.foreground,
        labelText: c.foreground,

        // -- Actors (sequence diagrams) --
        actorBkg: c.primary,
        actorTextColor: c.primaryForeground,
        actorBorder: c.primary,
        actorLineColor: c.mutedForeground,

        // -- Signals / messages --
        signalColor: c.foreground,
        signalTextColor: c.foreground,

        // -- Loop boxes --
        loopTextColor: c.foreground,
        activationBorderColor: c.primary,
        activationBkgColor: isDark ? lighten(c.background, 0.1) : darken(c.background, 0.06),

        // -- Sections (gantt, pie) --
        sectionBkgColor: nodeFill,
        altSectionBkgColor: nodeFill2,
        sectionBkgColor2: nodeFill2,
        taskBkgColor: c.primary,
        taskTextColor: c.primaryForeground,
        taskBorderColor: c.primary,
        activeTaskBkgColor: c.primary,
        activeTaskBorderColor: c.ring,
        doneTaskBkgColor: c.muted,
        doneTaskBorderColor: c.border,

        // -- Grid --
        gridColor: c.border,
        todayLineColor: c.destructive,

        // -- Class diagram --
        classText: c.foreground,

        // -- State diagram --
        labelColor: c.foreground,
        altBackground: nodeFill2,

        // -- ER diagram --
        attributeBackgroundColorEven: nodeFill,
        attributeBackgroundColorOdd: nodeFill2,

        // -- Pie chart --
        pie1: c.primary,
        pie2: isDark ? '#22c55e' : '#16a34a',
        pie3: isDark ? '#3b82f6' : '#2563eb',
        pie4: isDark ? '#f59e0b' : '#d97706',
        pie5: isDark ? '#ec4899' : '#db2777',
        pie6: isDark ? '#8b5cf6' : '#7c3aed',
        pie7: isDark ? '#14b8a6' : '#0d9488',
        pie8: isDark ? '#ef4444' : '#dc2626',
        pie9: c.muted,
        pie10: c.accent,
        pie11: c.ring,
        pie12: c.secondary,
        pieStrokeColor: c.border,
        pieTitleTextColor: c.foreground,
        pieSectionTextColor: c.foreground,
        pieLegendTextColor: c.foreground,

        // -- Flowchart fill types for subgraphs --
        fillType0: isDark ? lighten(c.background, 0.06) : darken(c.background, 0.03),
        fillType1: isDark ? lighten(c.background, 0.1) : darken(c.background, 0.06),
        fillType2: isDark ? lighten(c.background, 0.14) : darken(c.background, 0.09),
        fillType3: isDark ? lighten(c.background, 0.18) : darken(c.background, 0.12),
        fillType4: isDark ? lighten(c.background, 0.22) : darken(c.background, 0.15),
        fillType5: isDark ? lighten(c.background, 0.26) : darken(c.background, 0.18),
        fillType6: isDark ? lighten(c.background, 0.3) : darken(c.background, 0.21),
        fillType7: isDark ? lighten(c.background, 0.34) : darken(c.background, 0.24),

        // -- Ensure edge labels are readable --
        edgeLabelBackground: isDark ? lighten(c.background, 0.05) : darken(c.background, 0.02),

        // -- Cluster (subgraph) --
        clusterBkg: isDark ? lighten(c.background, 0.04) : darken(c.background, 0.02),
        clusterBorder: c.border,
        titleColor: c.foreground,

        // -- Git graph --
        git0: c.primary,
        git1: isDark ? '#22c55e' : '#16a34a',
        git2: isDark ? '#3b82f6' : '#2563eb',
        git3: isDark ? '#f59e0b' : '#d97706',
        git4: isDark ? '#ec4899' : '#db2777',
        git5: isDark ? '#8b5cf6' : '#7c3aed',
        git6: isDark ? '#14b8a6' : '#0d9488',
        git7: isDark ? '#ef4444' : '#dc2626',
        gitBranchLabel0: c.primaryForeground,
        gitInv0: c.primaryForeground,

        // -- Requirement --
        requirementBackground: nodeFill,
        requirementBorderColor: c.border,
        requirementTextColor: c.foreground,
        relationColor: c.mutedForeground,
        relationLabelBackground: c.background,
        relationLabelColor: c.foreground,
      },
      flowchart: {
        useMaxWidth: true,
        htmlLabels: true,
        curve: 'basis' as const,
        padding: 10,
      },
      gantt: {
        useMaxWidth: true,
        padding: 10,
        barHeight: 20,
        fontSize: 13,
      },
      sequence: {
        useMaxWidth: true,
        boxMargin: 8,
        boxTextMargin: 4,
        noteMargin: 8,
        messageMargin: 30,
      },
      class: { useMaxWidth: true },
      state: { useMaxWidth: true },
      er: { useMaxWidth: true },
      pie: { useMaxWidth: true, textPosition: 0.75 },
      git: { useMaxWidth: true },
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [themeKey]);

  const cleanupErrorElements = useCallback(() => {
    if (typeof window === 'undefined') return;
    const body = document.body;
    // Clean up any error SVGs injected by Mermaid
    const errorSvgs = body.querySelectorAll('svg[data-error="true"], svg[id^="mermaid-"][class*="error"]');
    errorSvgs.forEach((el) => el.remove());
  }, []);

  const renderDiagram = useCallback(async () => {
    if (!code.trim()) {
      setSvg('');
      setError(null);
      return;
    }

    setIsRendering(true);
    setError(null);
    cleanupErrorElements();

    try {
      await mermaid.initialize(mermaidConfig);
      const cleanCode = code.replace(/^```(?:mermaid|mmd)?\n?/, '').replace(/```$/, '');
      const parseResult = await mermaid.parse(cleanCode, { suppressErrors: true });

      if (!parseResult) {
        const pendingSince = pendingSinceRef.current ?? Date.now();
        pendingSinceRef.current = pendingSince;

        if (Date.now() - pendingSince < 2000) {
          setSvg('');
          setError(null);
          setIsRendering(true);
          return;
        }

        throw new Error('Invalid Mermaid syntax');
      }

      const renderId = `${renderIdRef.current}-${renderCountRef.current++}`;
      const { svg: renderedSvg, bindFunctions } = await mermaid.render(renderId, cleanCode);
      bindFunctionsRef.current = bindFunctions || null;
      setSvg(enhanceSvgSizing(renderedSvg));
      pendingSinceRef.current = null;
      cleanupErrorElements();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      setSvg('');
      cleanupErrorElements();
    } finally {
      setIsRendering(false);
    }
  }, [code, mermaidConfig, cleanupErrorElements]);

  // Re-render when code changes OR when theme changes
  useEffect(() => {
    if (!code.trim()) {
      setIsRendering(false);
      return;
    }

    setIsRendering(true);
    pendingSinceRef.current = Date.now();
    if (pendingTimeoutRef.current) {
      window.clearTimeout(pendingTimeoutRef.current);
    }

    const handle = window.setTimeout(() => {
      void renderDiagram();
    }, 250);

    pendingTimeoutRef.current = handle;

    return () => {
      window.clearTimeout(handle);
    };
  }, [code, renderDiagram, themeKey]);

  useEffect(() => {
    if (!svg) return;
    const container = isExpanded ? expandedContainerRef.current : containerRef.current;
    if (container && bindFunctionsRef.current) {
      bindFunctionsRef.current(container);
    }
  }, [svg, isExpanded]);

  const handleCopyCode = useCallback(() => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }, [code]);

  const handleZoom = (direction: 'in' | 'out' | 'reset', isModal = false) => {
    const setter = isModal ? setExpandedScale : setScale;
    const offsetSetter = isModal ? setExpandedOffset : setOffset;
    setter((current) => {
      if (direction === 'reset') {
        offsetSetter({ x: 0, y: 0 });
        return 1;
      }
      const delta = direction === 'in' ? 0.1 : -0.1;
      return clamp(Number((current + delta).toFixed(2)), 0.6, 2.5);
    });
  };

  const handleWheel = (event: React.WheelEvent<HTMLDivElement>, isModal = false) => {
    const scaleValue = isModal ? expandedScale : scale;
    const offsetSetter = isModal ? setExpandedOffset : setOffset;

    if (event.ctrlKey || event.metaKey) {
      event.preventDefault();
      event.stopPropagation();
      const direction = event.deltaY < 0 ? 'in' : 'out';
      const next = clamp(Number((scaleValue + (direction === 'in' ? 0.1 : -0.1)).toFixed(2)), 0.6, 2.5);
      if (isModal) {
        setExpandedScale(next);
      } else {
        setScale(next);
      }
      return;
    }

    event.preventDefault();
    event.stopPropagation();
    offsetSetter((current) => ({
      x: current.x - event.deltaX,
      y: current.y - event.deltaY,
    }));
  };

  const startPan = (event: React.PointerEvent<HTMLDivElement>, isModal = false) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    panStartRef.current = { x: event.clientX, y: event.clientY };
    panOriginRef.current = isModal ? expandedOffset : offset;
    if (isModal) {
      setIsExpandedPanning(true);
    } else {
      setIsPanning(true);
    }
  };

  const onPanMove = (event: React.PointerEvent<HTMLDivElement>, isModal = false) => {
    const active = isModal ? isExpandedPanning : isPanning;
    if (!active) return;
    event.preventDefault();
    event.stopPropagation();
    const deltaX = event.clientX - panStartRef.current.x;
    const deltaY = event.clientY - panStartRef.current.y;
    const next = {
      x: panOriginRef.current.x + deltaX,
      y: panOriginRef.current.y + deltaY,
    };
    if (isModal) {
      setExpandedOffset(next);
    } else {
      setOffset(next);
    }
  };

  const endPan = (event: React.PointerEvent<HTMLDivElement>, isModal = false) => {
    event.preventDefault();
    event.stopPropagation();
    if (isModal) {
      setIsExpandedPanning(false);
    } else {
      setIsPanning(false);
    }
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const zoomLabel = `${Math.round(scale * 100)}%`;
  const expandedZoomLabel = `${Math.round(expandedScale * 100)}%`;

  return (
    <div key={blockKey} className="my-3 rounded-lg border border-border bg-card/40 overflow-hidden">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Icon name="git-branch" size={12} className="text-primary" />
          </div>
          <span className="text-xs font-medium text-foreground">{t('chat.mermaidDiagram')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopyCode}
            className={cn(
              'w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors',
              copied ? 'text-green-500' : 'text-muted-foreground'
            )}
            title={copied ? t('chat.copied') : t('chat.copyCode')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
          </button>
          <button
            onClick={() => setShowCodeInline((current) => !current)}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground"
            title={showCodeInline ? t('chat.hideCode') : t('chat.showCode')}
          >
            <Icon name="code" size={12} />
          </button>
          <button
            onClick={() => setIsExpanded(true)}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground"
            title={t('chat.expand')}
          >
            <Icon name="maximize" size={12} />
          </button>
        </div>
      </div>

      <div className="relative w-full">
        <div className="w-full h-[320px] overflow-hidden relative bg-card/20">
          <div
            className="mermaid-wrapper w-full h-full flex items-center justify-center p-3"
          >
            {showCodeInline ? (
              <div className="w-full h-full px-3 py-2 overflow-auto">
                <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/90">
                  {code}
                </pre>
              </div>
            ) : isRendering ? (
              <div className="flex flex-col items-center justify-center gap-2 h-full">
                <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                <span className="text-xs text-muted-foreground">{t('chat.renderingDiagram')}</span>
              </div>
            ) : error ? (
              <div className="text-xs text-destructive text-center px-4">
                <div className="font-medium">{t('chat.mermaidRenderError')}</div>
                <div className="mt-1 opacity-70">{error}</div>
              </div>
            ) : (
              <div
                ref={containerRef}
                className="mermaid-diagram-container origin-top-left"
                style={{
                  width: '100%',
                  height: '100%',
                  cursor: isPanning ? 'grabbing' : 'grab',
                  transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
                  userSelect: 'none',
                  touchAction: 'none',
                }}
                onWheel={(event) => handleWheel(event)}
                onPointerDown={(event) => startPan(event)}
                onPointerMove={(event) => onPanMove(event)}
                onPointerUp={(event) => endPan(event)}
                onPointerLeave={(event) => endPan(event)}
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        </div>

        {!showCodeInline && (
          <div className="absolute bottom-2 right-2 flex items-center gap-1 rounded-md border border-border bg-background/80 px-1.5 py-1 text-xs text-muted-foreground shadow-sm">
          <button
            onClick={() => handleZoom('out')}
            className="w-6 h-6 rounded-md hover:bg-accent flex items-center justify-center"
            title={t('chat.zoomOut')}
          >
            <Icon name="minus" size={12} />
          </button>
          <span className="px-1 font-mono text-[11px]">{zoomLabel}</span>
          <button
            onClick={() => handleZoom('in')}
            className="w-6 h-6 rounded-md hover:bg-accent flex items-center justify-center"
            title={t('chat.zoomIn')}
          >
            <Icon name="plus" size={12} />
          </button>
          <button
            onClick={() => handleZoom('reset')}
            className="w-6 h-6 rounded-md hover:bg-accent flex items-center justify-center"
            title={t('chat.resetZoom')}
          >
            <Icon name="rotate-ccw" size={12} />
          </button>
          </div>
        )}
      </div>

      {isExpanded && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm">
          <div className="w-[92vw] h-[86vh] bg-card border border-border rounded-xl shadow-2xl flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                  <Icon name="git-branch" size={13} className="text-primary" />
                </div>
                <span className="text-sm font-medium text-foreground">{t('chat.mermaidDiagram')}</span>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleCopyCode}
                  className={cn(
                    'w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent transition-colors',
                    copied ? 'text-green-500' : 'text-muted-foreground'
                  )}
                  title={copied ? t('chat.copied') : t('chat.copyCode')}
                >
                  <Icon name={copied ? 'check' : 'copy'} size={13} />
                </button>
                <button
                  onClick={() => setShowCodeExpanded((current) => !current)}
                  className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground"
                  title={showCodeExpanded ? t('chat.hideCode') : t('chat.showCode')}
                >
                  <Icon name="code" size={13} />
                </button>
                <button
                  onClick={() => setIsExpanded(false)}
                  className="w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground"
                  title={t('common.close')}
                >
                  <Icon name="x" size={14} />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-hidden">
              <div className="w-full h-full relative">
                <div className="w-full h-full overflow-hidden bg-card/20">
                  <div
                    className="mermaid-wrapper w-full h-full flex items-center justify-center p-4"
                  >
                    {showCodeExpanded ? (
                      <div className="w-full h-full px-4 py-3 overflow-auto">
                        <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/90">
                          {code}
                        </pre>
                      </div>
                    ) : isRendering ? (
                      <div className="flex flex-col items-center justify-center gap-3 h-full">
                        <div className="w-10 h-10 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                        <span className="text-sm text-muted-foreground">{t('chat.renderingDiagram')}</span>
                      </div>
                    ) : error ? (
                      <div className="text-sm text-destructive text-center px-6">
                        <div className="font-medium">{t('chat.mermaidRenderError')}</div>
                        <div className="mt-2 opacity-70">{error}</div>
                      </div>
                    ) : (
                      <div
                        ref={expandedContainerRef}
                        className="mermaid-diagram-container origin-top-left"
                        style={{
                          width: '100%',
                          height: '100%',
                          cursor: isExpandedPanning ? 'grabbing' : 'grab',
                          transform: `translate(${expandedOffset.x}px, ${expandedOffset.y}px) scale(${expandedScale})`,
                          userSelect: 'none',
                          touchAction: 'none',
                        }}
                        onWheel={(event) => handleWheel(event, true)}
                        onPointerDown={(event) => startPan(event, true)}
                        onPointerMove={(event) => onPanMove(event, true)}
                        onPointerUp={(event) => endPan(event, true)}
                        onPointerLeave={(event) => endPan(event, true)}
                        dangerouslySetInnerHTML={{ __html: svg }}
                      />
                    )}
                  </div>
                </div>

                {!showCodeExpanded && (
                  <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border border-border bg-background/90 px-2 py-1 text-xs text-muted-foreground shadow-sm">
                  <button
                    onClick={() => handleZoom('out', true)}
                    className="w-6 h-6 rounded-md hover:bg-accent flex items-center justify-center"
                    title={t('chat.zoomOut')}
                  >
                    <Icon name="minus" size={12} />
                  </button>
                  <span className="px-1 font-mono text-[11px]">{expandedZoomLabel}</span>
                  <button
                    onClick={() => handleZoom('in', true)}
                    className="w-6 h-6 rounded-md hover:bg-accent flex items-center justify-center"
                    title={t('chat.zoomIn')}
                  >
                    <Icon name="plus" size={12} />
                  </button>
                  <button
                    onClick={() => handleZoom('reset', true)}
                    className="w-6 h-6 rounded-md hover:bg-accent flex items-center justify-center"
                    title={t('chat.resetZoom')}
                  >
                    <Icon name="rotate-ccw" size={12} />
                  </button>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
