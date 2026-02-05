import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import mermaid from 'mermaid';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { useAppStore } from '../../stores/useAppStore';

interface MermaidRendererProps {
  code: string;
  blockKey: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

const toHex = (value: string): string => {
  const trimmed = value.trim();
  if (!trimmed) return '#000000';
  if (trimmed.startsWith('#')) return trimmed;

  const rgbMatch = trimmed.match(/rgba?\(([^)]+)\)/i);
  if (rgbMatch) {
    const parts = rgbMatch[1].split(',').map((part) => Number(part.trim()));
    const [r, g, b] = parts;
    return `#${[r, g, b]
      .map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  const parts = trimmed.split(' ').filter(Boolean).map((part) => Number(part));
  if (parts.length >= 3 && parts.every((val) => !Number.isNaN(val))) {
    const [r, g, b] = parts;
    return `#${[r, g, b]
      .map((c) => clamp(Math.round(c), 0, 255).toString(16).padStart(2, '0'))
      .join('')}`;
  }

  return '#000000';
};

const getThemeColor = (name: string, fallback: string): string => {
  if (typeof window === 'undefined') return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--${name}`);
  const hex = toHex(value || fallback);
  return hex.startsWith('#') ? hex : `#${hex}`;
};

const isMermaidComplete = (code: string): boolean => {
  const trimmed = code.trim();
  if (!trimmed) return false;

  // If we still have markdown fences, validate closure
  if (trimmed.includes('```')) {
    if (!trimmed.endsWith('```')) return false;
    const mermaidContent = trimmed.replace(/^```(?:mermaid|mmd)?\n?/, '').replace(/```$/, '');
    if (!mermaidContent.trim()) return false;
    const hasMermaidSyntax = /^(graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|gantt|pie|mindmap|erDiagram|gitGraph|journey|C4Context|requirementDiagram|relationDiagram|info|flowchart\.?(LR|TD|BT|RL)|graph\.?(LR|TD|BT|RL))/i.test(mermaidContent.trim());
    return hasMermaidSyntax;
  }

  // MarkdownRenderer already strips fences, so treat non-empty code as complete
  return true;
};

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({ code, blockKey }) => {
  const { t } = useTranslation();
  const activeThemeId = useAppStore((state) => state.activeThemeId);

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

  const mermaidConfig = useMemo(() => {
    const isDark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
    return {
      startOnLoad: false,
      securityLevel: 'strict' as const,
      theme: 'base' as const,
      darkMode: isDark,
      fontFamily: '"JetBrains Mono", "Fira Code", "SF Mono", Monaco, Inconsolata, monospace',
      themeVariables: {
        background: getThemeColor('background', '#0b0b0b'),
        primaryColor: getThemeColor('card', '#111827'),
        primaryTextColor: getThemeColor('foreground', '#f8fafc'),
        primaryBorderColor: getThemeColor('border', '#334155'),
        secondaryColor: getThemeColor('muted', '#1f2937'),
        secondaryTextColor: getThemeColor('foreground', '#f8fafc'),
        tertiaryColor: getThemeColor('accent', '#111827'),
        tertiaryTextColor: getThemeColor('foreground', '#f8fafc'),
        lineColor: getThemeColor('muted-foreground', '#94a3b8'),
        noteBkgColor: getThemeColor('muted', '#1f2937'),
        noteTextColor: getThemeColor('foreground', '#f8fafc'),
      },
      flowchart: {
        useMaxWidth: true,
      },
    };
  }, [activeThemeId]);

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

    // Check if mermaid block is still being streamed
    if (!isMermaidComplete(code)) {
      setSvg('');
      setError(null);
      setIsRendering(true);
      return;
    }

    setIsRendering(true);
    setError(null);
    cleanupErrorElements();

    try {
      await mermaid.initialize(mermaidConfig);
      await mermaid.parse(code.replace(/^```(?:mermaid|mmd)?\n?/, '').replace(/```$/, ''));
      const renderId = `${renderIdRef.current}-${renderCountRef.current++}`;
      const cleanCode = code.replace(/^```(?:mermaid|mmd)?\n?/, '').replace(/```$/, '');
      const { svg: renderedSvg, bindFunctions } = await mermaid.render(renderId, cleanCode);
      bindFunctionsRef.current = bindFunctions || null;
      setSvg(renderedSvg);
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

  useEffect(() => {
    if (!code.trim()) {
      setIsRendering(false);
      return;
    }

    setIsRendering(true);
    const handle = window.setTimeout(() => {
      void renderDiagram();
    }, 250);

    return () => {
      window.clearTimeout(handle);
    };
  }, [code, renderDiagram]);

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
    event.currentTarget.setPointerCapture(event.pointerId);
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

      <div className="relative">
        <div className="max-h-[420px] overflow-hidden">
          <div
            className="mermaid-container min-h-[180px]"
            data-theme={activeThemeId}
            onWheel={(event) => handleWheel(event)}
          >
            {showCodeInline ? (
              <div className="w-full h-full px-3 py-2">
                <pre className="text-xs font-mono whitespace-pre-wrap text-foreground/90">
                  {code}
                </pre>
              </div>
            ) : isRendering ? (
              <div className="flex flex-col items-center justify-center gap-2 h-full min-h-[180px]">
                <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
                <span className="text-xs text-muted-foreground">{t('chat.renderingDiagram')}</span>
              </div>
            ) : error ? (
              <div className="text-xs text-destructive text-center">
                <div className="font-medium">{t('chat.mermaidRenderError')}</div>
                <div className="mt-1 opacity-70">{error}</div>
              </div>
            ) : (
              <div
                ref={containerRef}
                className={cn(
                  'origin-top-left touch-none select-none',
                  isPanning ? 'cursor-grabbing' : 'cursor-grab'
                )}
                style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})` }}
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

            <div className="flex-1 overflow-hidden grid grid-cols-1">
              <div className="relative h-full">
                <div className="h-full overflow-hidden">
                  <div
                    className="mermaid-container min-h-full"
                    data-theme={activeThemeId}
                    onWheel={(event) => handleWheel(event, true)}
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
                      <div className="text-xs text-destructive text-center">
                        <div className="font-medium">{t('chat.mermaidRenderError')}</div>
                        <div className="mt-1 opacity-70">{error}</div>
                      </div>
                    ) : (
                      <div
                        ref={expandedContainerRef}
                        className={cn(
                          'origin-top-left touch-none select-none',
                          isExpandedPanning ? 'cursor-grabbing' : 'cursor-grab'
                        )}
                        style={{ transform: `translate(${expandedOffset.x}px, ${expandedOffset.y}px) scale(${expandedScale})` }}
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
