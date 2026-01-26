import React, { useEffect, useState } from 'react';
import { Header } from './components/layout/Header';
import { Footer } from './components/layout/Footer';
import { LeftPanel } from './components/layout/LeftPanel';
import { ChatZone } from './components/chat/ChatZone';
import { RightPanel } from './components/layout/RightPanel';
import { PanelResizer } from './components/layout/PanelResizer';
import { DiffModal } from './components/modals/DiffModal';
import { SettingsModal } from './components/modals/SettingsModal';
import { AccountModal } from './components/modals/AccountModal';
import { ProjectModal } from './components/modals/ProjectModal';
import { ToolsSettingsModal } from './components/modals/ToolsSettingsModal';
import { CodeFileViewerModal } from './components/modals/CodeFileViewerModal';
import { useAppStore } from './stores/useAppStore';
import { useChatStore } from './stores/useChatStore';
import { useTaskStore } from './stores/useTaskStore';
import { useAIStore } from './stores/useAIStore';
import { useAuthStore } from './stores/useAuthStore';
import { useToolsStore } from './stores/useToolsStore';

const App: React.FC = () => {
  const [isLeftOpen, setIsLeftOpen] = useState(true);
  const [isRightOpen, setIsRightOpen] = useState(true);
  const initializeApp = useAppStore((state) => state.initialize);
  const initializeChat = useChatStore((state) => state.initialize);
  const initializeTasks = useTaskStore((state) => state.initialize);
  const initializeAI = useAIStore((state) => state.initialize);
  const initializeTools = useToolsStore((state) => state.loadSettings);
  const checkSession = useAuthStore((state) => state.checkSession);
  const leftPanelWidth = useAppStore((state) => state.leftPanelWidth);
  const rightPanelWidth = useAppStore((state) => state.rightPanelWidth);
  const setLeftPanelWidth = useAppStore((state) => state.setLeftPanelWidth);
  const setRightPanelWidth = useAppStore((state) => state.setRightPanelWidth);

  useEffect(() => {
    void initializeApp();
    void initializeChat();
    void initializeTasks();
    void initializeAI();
    void initializeTools();
    void checkSession();
  }, [initializeApp, initializeChat, initializeTasks, initializeAI, initializeTools, checkSession]);

  return (
    <div className="h-screen w-screen bg-background grid grid-rows-[48px_1fr_32px] overflow-hidden">
      {/* Header */}
      <Header
        isLeftOpen={isLeftOpen}
        isRightOpen={isRightOpen}
        onToggleLeft={() => setIsLeftOpen((prev) => !prev)}
        onToggleRight={() => setIsRightOpen((prev) => !prev)}
      />

      {/* Main Content Area */}
      <div className="flex overflow-hidden">
        {/* Left Panel - Projects */}
        {isLeftOpen && (
          <>
            <LeftPanel className="hidden md:flex" width={leftPanelWidth} />
            <PanelResizer
              direction="horizontal"
              onResize={(delta) => setLeftPanelWidth(leftPanelWidth + delta)}
              className="hidden md:flex"
            />
          </>
        )}

        {/* Center - Chat Zone */}
        <ChatZone />

        {/* Right Panel - Git Trees */}
        {isRightOpen && (
          <>
            <PanelResizer
              direction="horizontal"
              onResize={(delta) => setRightPanelWidth(rightPanelWidth - delta)}
              className="hidden lg:flex"
            />
            <RightPanel className="hidden lg:flex" width={rightPanelWidth} />
          </>
        )}
      </div>

      {/* Footer */}
      <Footer />

      {/* Modals */}
      <DiffModal />
      <SettingsModal />
      <AccountModal />
      <ProjectModal />
      <ToolsSettingsModal />
      <CodeFileViewerModal />
    </div>
  );
};

export default App;
