import type { ReasoningEffort } from '../../types';

export interface ReasoningCompatibility {
  disableReasoning: () => void;
  disableEffort: (effort: ReasoningEffort) => void;
}
