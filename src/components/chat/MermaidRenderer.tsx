import React, { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import mermaid from 'mermaid';
import { Icon } from '../ui/Icon';
import { cn } from '../../utils/cn';
import { useTheme } from '../theme/ThemeProvider';

interface MermaidRendererProps {
  code: string;
  blockKey: number;
}

let renderCount = 0;
const mermaidCache = new Map<string, string>();

const cleanupRenderArtifacts = (diagramId: string): void => {
  if (typeof document === 'undefined') {
    return;
  }

  document.getElementById(diagramId)?.remove();
  document.getElementById(`d${diagramId}`)?.remove();
};

export const MermaidRenderer: React.FC<MermaidRendererProps> = ({ code, blockKey }) => {
  const { t } = useTranslation();
  const { isDark } = useTheme();

  const [svg, setSvg] = useState<string>('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showCode, setShowCode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [isVisible, setIsVisible] = useState(false);

  const containerRef = useRef<HTMLDivElement>(null);
  const cleanCode = code.replace(/^```(?:mermaid|mmd)?\n?/, '').replace(/```$/, '').trim();
  const cacheKey = `${isDark ? 'dark' : 'light'}:${cleanCode}`;
  const diagramIdRef = useRef(`mermaid-${blockKey}-${renderCount++}`);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver === 'undefined') {
      setIsVisible(true);
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setIsVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: '240px 0px' }
    );

    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let isMounted = true;
    const diagramId = diagramIdRef.current;

    if (!isVisible && !isExpanded) {
      return;
    }

    const cachedSvg = mermaidCache.get(cacheKey);
    if (cachedSvg) {
      setSvg(cachedSvg);
      setError(null);
      setIsLoading(false);
      return;
    }

    setIsLoading(true);
    setError(null);

    const renderDiagram = async () => {
      try {
        mermaid.initialize({
          startOnLoad: false,
          securityLevel: 'loose',
          theme: isDark ? 'dark' : 'default',
          fontFamily: '"Inter", system-ui, sans-serif',
          suppressErrorRendering: true,
        });

        const isValid = await mermaid.parse(cleanCode, { suppressErrors: true });
        if (!isValid) {
          throw new Error('Invalid Mermaid syntax');
        }

        cleanupRenderArtifacts(diagramId);
        const { svg: renderedSvg } = await mermaid.render(diagramId, cleanCode);
        cleanupRenderArtifacts(diagramId);

        if (isMounted) {
          mermaidCache.set(cacheKey, renderedSvg);
          setSvg(renderedSvg);
          setError(null);
        }
      } catch (err) {
        cleanupRenderArtifacts(diagramId);
        if (isMounted) {
          const message = err instanceof Error ? err.message : 'Unknown error';
          setError(message);
          setSvg('');
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    };

    const timeoutId = setTimeout(renderDiagram, 16);

    return () => {
      isMounted = false;
      clearTimeout(timeoutId);
      cleanupRenderArtifacts(diagramId);
    };
  }, [cacheKey, cleanCode, isDark, isExpanded, isVisible]);

  const handleCopy = () => {
    navigator.clipboard.writeText(code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const renderContent = () => {
    if (showCode) {
      return (
        <pre className="p-4 text-xs font-mono whitespace-pre-wrap text-foreground/90 overflow-auto">
          {code}
        </pre>
      );
    }

    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center h-64 gap-3">
          <div className="w-8 h-8 rounded-full border-2 border-primary/30 border-t-primary animate-spin" />
          <span className="text-xs text-muted-foreground">{t('chat.renderingDiagram')}</span>
        </div>
      );
    }

    if (error) {
      return (
        <div className="flex flex-col items-center justify-center h-64 text-destructive">
          <Icon name="alert-circle" size={24} className="mb-2" />
          <span className="text-sm font-medium">{t('chat.mermaidRenderError')}</span>
          <span className="text-xs opacity-70 mt-1">{error}</span>
        </div>
      );
    }

    return (
      <div 
        className="flex items-center justify-center p-4 min-h-[200px]"
        dangerouslySetInnerHTML={{ __html: svg }}
      />
    );
  };

  const renderExpandedModal = () => {
    if (!isExpanded) return null;

    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-background/80 p-4 backdrop-blur-sm">
        <div className="flex h-[min(86vh,calc(100vh-2rem))] w-full max-w-[calc(100vw-2rem)] flex-col overflow-hidden rounded-xl border border-border bg-card shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-muted/30">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
                <Icon name="git-branch" size={13} className="text-primary" />
              </div>
              <span className="text-sm font-medium text-foreground">{t('chat.mermaidDiagram')}</span>
            </div>
            <div className="flex items-center gap-1">
              <button
                onClick={handleCopy}
                className={cn(
                  'w-8 h-8 flex items-center justify-center rounded-md hover:bg-accent transition-colors',
                  copied ? 'text-green-500' : 'text-muted-foreground'
                )}
                title={copied ? t('chat.copied') : t('chat.copyCode')}
              >
                <Icon name={copied ? 'check' : 'copy'} size={13} />
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
          
          {/* Content */}
          <div className="flex-1 overflow-auto p-6">
            {showCode ? (
              <pre className="text-sm font-mono whitespace-pre-wrap text-foreground/90">
                {code}
              </pre>
            ) : (
              <div 
                className="flex items-center justify-center h-full"
                dangerouslySetInnerHTML={{ __html: svg }}
              />
            )}
          </div>
        </div>
      </div>
    );
  };

  return (
    <div ref={containerRef} className="my-3 rounded-lg border border-border bg-card/40 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border bg-muted/30">
        <div className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-md bg-primary/10 border border-primary/20 flex items-center justify-center">
            <Icon name="git-branch" size={12} className="text-primary" />
          </div>
          <span className="text-xs font-medium text-foreground">{t('chat.mermaidDiagram')}</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={handleCopy}
            className={cn(
              'w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors',
              copied ? 'text-green-500' : 'text-muted-foreground'
            )}
            title={copied ? t('chat.copied') : t('chat.copyCode')}
          >
            <Icon name={copied ? 'check' : 'copy'} size={12} />
          </button>
          <button
            onClick={() => setShowCode((v) => !v)}
            className="w-7 h-7 flex items-center justify-center rounded-md hover:bg-accent transition-colors text-muted-foreground"
            title={showCode ? t('chat.hideCode') : t('chat.showCode')}
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

      {/* Content */}
      <div className="relative">
        {renderContent()}
      </div>

      {/* Expanded Modal */}
      {renderExpandedModal()}
    </div>
  );
};

export default MermaidRenderer;
