import type { AppMode } from '../types';

export const demoWorkflowJourney = import.meta.env.DEV && import.meta.env.VITE_MACRO_DEMO === '1';

/** Implement remains the persisted mode and Pilot discriminator. */
export const isOperateWorkspace = (mode: AppMode) => mode === 'Implement' && !demoWorkflowJourney;
