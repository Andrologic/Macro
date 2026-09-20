import type React from 'react';
import type { AppMode } from '../../types';

export type ModePanelSlot = 'left' | 'center' | 'right';
export type ModePanelComponent = React.ComponentType;

export interface ModePanelLoader {
  id: string;
  label: string;
  mode: AppMode;
  panel: ModePanelSlot;
  load: () => Promise<ModePanelComponent>;
  reset: () => void;
  getCachedComponent: () => ModePanelComponent | null;
}

interface CreateModePanelLoaderOptions {
  id: string;
  label: string;
  mode: AppMode;
  panel: ModePanelSlot;
  importComponent: () => Promise<ModePanelComponent>;
}

export interface ModePanelPreloadResult {
  loaded: string[];
  failed: Array<{ id: string; error: unknown }>;
  timedOut: boolean;
}

export const createModePanelLoader = ({
  id,
  label,
  mode,
  panel,
  importComponent,
}: CreateModePanelLoaderOptions): ModePanelLoader => {
  let component: ModePanelComponent | null = null;
  let pending: Promise<ModePanelComponent> | null = null;

  return {
    id,
    label,
    mode,
    panel,
    load: () => {
      if (component) {
        return Promise.resolve(component);
      }

      if (!pending) {
        pending = importComponent()
          .then((loadedComponent) => {
            component = loadedComponent;
            return loadedComponent;
          })
          .catch((error) => {
            pending = null;
            throw error;
          });
      }

      return pending;
    },
    reset: () => {
      component = null;
      pending = null;
    },
    getCachedComponent: () => component,
  };
};
