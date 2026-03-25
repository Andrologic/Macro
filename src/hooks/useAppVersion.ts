import { useEffect, useState } from 'react';
import { buildAppVersion, loadAppVersion } from '../services/appVersion';

export function useAppVersion(): string {
  const [appVersion, setAppVersion] = useState(buildAppVersion);

  useEffect(() => {
    let cancelled = false;

    void loadAppVersion().then((version) => {
      if (!cancelled) {
        setAppVersion(version);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return appVersion;
}
