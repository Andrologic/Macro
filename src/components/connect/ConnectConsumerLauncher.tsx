import { lazy, Suspense, useRef, useState } from 'react';
import { Monitor } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../ui/Button';
import type { ConsumerReaderPorts } from '../../services/macroPilot/consumerReader';
const ReaderDialog = lazy(() => import('./ConnectConsumerDialog').then(module => ({ default: module.ConnectConsumerDialog })));
export function ConnectConsumerLauncher({ enabled, createPorts }: { enabled: boolean; createPorts(): ConsumerReaderPorts }) {
  const { t } = useTranslation(); const button = useRef<HTMLButtonElement>(null);
  const [ports, setPorts] = useState<ConsumerReaderPorts | null>(null); const [failed, setFailed] = useState(false);
  return <section className="space-y-2 rounded-lg border border-border/50 bg-card/40 p-3">
    <div className="flex items-center gap-3"><Monitor aria-hidden="true" className="h-4 w-4 shrink-0 text-muted-foreground" /><div className="min-w-0 flex-1"><h4 className="text-sm font-medium">{t('settings.connectReader.launchTitle')}</h4><p className="text-xs text-muted-foreground">{t('settings.connectReader.launchHelp')}</p></div>
      <Button ref={button} size="sm" variant="secondary" disabled={!enabled} onClick={() => { try { setPorts(createPorts()); setFailed(false); } catch { setFailed(true); } }}>{t('settings.connectReader.open')}</Button>
    </div>
    {failed && <p role="alert" className="text-xs text-destructive">{t('settings.connectReader.errors.context_changed')}</p>}
    {ports && <Suspense fallback={<p role="status">{t('common.loading')}</p>}><ReaderDialog ports={ports} onClose={() => setPorts(null)} returnFocusRef={button} /></Suspense>}
  </section>;
}
