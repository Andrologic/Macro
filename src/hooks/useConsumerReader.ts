import { useEffect, useState, useSyncExternalStore } from 'react';
import { ConsumerReader, type ConsumerReaderPorts, type ReaderSnapshot } from '../services/macroPilot/consumerReader';
const initial: ReaderSnapshot = { phase: 'loading', error: null, choices: [], panels: [] };
const emptySubscribe = () => () => {};
export function useConsumerReader(ports: ConsumerReaderPorts) {
  const [reader, setReader] = useState<ConsumerReader | null>(null);
  const state = useSyncExternalStore(reader?.subscribe ?? emptySubscribe, reader?.getSnapshot ?? (() => initial));
  useEffect(() => {
    const current = new ConsumerReader(ports); setReader(current);
    const available = () => !document.hidden && navigator.onLine !== false;
    current.start(available());
    const changed = () => current.setAvailable(available());
    document.addEventListener('visibilitychange', changed); window.addEventListener('online', changed); window.addEventListener('offline', changed);
    return () => { document.removeEventListener('visibilitychange', changed); window.removeEventListener('online', changed); window.removeEventListener('offline', changed); current.dispose(); };
  }, [ports]);
  return { reader, state };
}
