import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import type { AppMode } from '../../types';

// Architect Mode components
import { NeedsPanel } from '../architect/NeedsPanel';
import { StrategyGraph } from '../plan/StrategyGraph.tsx';


// Implement Mode components
import { TaskQueue } from '../tasks/TaskQueue.tsx';
import { LiveCodePreview } from '../editor/LiveCodePreview.tsx';

// Chat Mode components
import { ConversationArchive } from '../chat/ConversationArchive.tsx';
import { ContextToolbox } from '../chat/ContextToolbox.tsx';

// Shared
import { ChatZone } from '../chat/ChatZone.tsx';

interface ModeRouterProps {
  panel: 'left' | 'center' | 'right';
}

interface PanelConfig {
  left: React.ComponentType<{ className?: string }>;
  center: React.ComponentType;
  right: React.ComponentType<{ className?: string }>;
}

const modeConfigs: Record<AppMode, PanelConfig> = {
  Architect: {
    left: NeedsPanel,
    center: ChatZone,
    right: StrategyGraph,
  },
  Implement: {
    left: TaskQueue,
    center: ChatZone,
    right: LiveCodePreview,
  },
  Chat: {
    left: ConversationArchive,
    center: ChatZone,
    right: ContextToolbox,
  },
};

export const ModeRouter: React.FC<ModeRouterProps> = ({ panel }) => {
  const mode = useAppStore((state) => state.mode);
  const config = modeConfigs[mode];

  if (panel === 'left') {
    const LeftComponent = config.left;
    return <LeftComponent />;
  }

  if (panel === 'center') {
    const CenterComponent = config.center;
    return <CenterComponent />;
  }

  if (panel === 'right') {
    const RightComponent = config.right;
    return <RightComponent />;
  }

  return null;
};
