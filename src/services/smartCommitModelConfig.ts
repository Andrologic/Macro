import type { ReasoningEffort } from '../types';

export type SmartCommitModelConfig =
  | { mode: 'conversation' }
  | {
      mode: 'dedicated';
      providerId: string;
      modelId: string;
      reasoningEffort: ReasoningEffort | null;
    };
