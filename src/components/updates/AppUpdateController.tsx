import { useEffect } from 'react';
import { isAutomaticUpdaterEnabled } from '../../services/appUpdater';
import { useAppUpdateStore } from '../../stores/useAppUpdateStore';
import { UpdateModal } from './UpdateModal';

const STARTUP_UPDATE_DELAY_MS = 3_000;
let automaticCheckStarted = false;

export interface AppUpdateControllerProps {
  enabled: boolean;
}

export const AppUpdateController: React.FC<AppUpdateControllerProps> = ({ enabled }) => {
  useEffect(() => {
    if (!enabled || automaticCheckStarted || !isAutomaticUpdaterEnabled()) return;
    automaticCheckStarted = true;

    const timeout = setTimeout(() => {
      void useAppUpdateStore.getState().checkForUpdates();
    }, STARTUP_UPDATE_DELAY_MS);

    return () => clearTimeout(timeout);
  }, [enabled]);

  if (!isAutomaticUpdaterEnabled()) return null;
  return <UpdateModal />;
};

export default AppUpdateController;
