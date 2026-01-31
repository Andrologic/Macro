import React, { useEffect } from 'react';
import { Header } from './components/layout/Header';
import { Toaster } from './components/ui/Toaster';
import { useWindowRestoration } from './hooks/useWindowRestoration';
import { PanelResizer } from './components/layout/PanelResizer';
import { ModeRouter } from './components/layout/ModeRouter';
import { DiffModal } from './components/modals/DiffModal';
import { SettingsModal } from './components/settings/SettingsModal';
import { AccountModal } from './components/modals/AccountModal';
import { ProjectModal } from './components/modals/ProjectModal';
import { CodeFileViewerModal } from './components/modals/CodeFileViewerModal';
import { useAppStore } from './stores/useAppStore';
import { useChatStore } from './stores/useChatStore';
import { useTaskStore } from './stores/useTaskStore';
import { useAIStore } from './stores/useAIStore';
import { useAuthStore } from './stores/useAuthStore';
import { useToolsStore } from './stores/useToolsStore';
import { useProviderStore } from './stores/useProviderStore';

const App: React.FC = () => {
  // Restore window size/position from preferences
  useWindowRestoration();

  const initializeApp = useAppStore((state) => state.initialize);
  const initializeChat = useChatStore((state) => state.initialize);
  const initializeTasks = useTaskStore((state) => state.initialize);
  const initializeAI = useAIStore((state) => state.initialize);
  const initializeTools = useToolsStore((state) => state.loadSettings);
  const initializeProviders = useProviderStore((state) => state.initialize);
  const checkSession = useAuthStore((state) => state.checkSession);
  
  // Panel state from store (persisted)
  const isLeftOpen = useAppStore((state) => state.isLeftPanelOpen);
  const isRightOpen = useAppStore((state) => state.isRightPanelOpen);
  const setLeftOpen = useAppStore((state) => state.setLeftPanelOpen);
  const setRightOpen = useAppStore((state) => state.setRightPanelOpen);
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
    void initializeProviders();
    void checkSession();
  }, [initializeApp, initializeChat, initializeTasks, initializeAI, initializeTools, initializeProviders, checkSession]);

  // Global Keyboard Shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // New Chat: Ctrl+N or Cmd+N
      if ((e.ctrlKey || e.metaKey) && e.key === 'n') {
        e.preventDefault();
        void useChatStore.getState().createConversation('New Conversation', null, null);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  return (
    <div className="h-screen w-screen bg-background grid grid-rows-[48px_1fr] overflow-hidden">
      {/* Header */}
      <Header
        isLeftOpen={isLeftOpen}
        isRightOpen={isRightOpen}
        onToggleLeft={() => setLeftOpen(!isLeftOpen)}
        onToggleRight={() => setRightOpen(!isRightOpen)}
      />

      {/* Main Content Area */}
      <div className="flex overflow-hidden h-full">
        {/* Left Panel - Mode-specific content */}
        {isLeftOpen && (
          <>
            <div 
              className="hidden md:flex flex-col shrink-0 h-full" 
              style={{ width: leftPanelWidth }}
            >
              <ModeRouter panel="left" />
            </div>
            <PanelResizer
              onResize={(delta) => setLeftPanelWidth(leftPanelWidth + delta)}
              className="hidden md:flex"
            />
          </>
        )}

        {/* Center - Chat Zone (all modes use chat in center) */}
        <div className="flex-1 min-w-0 overflow-hidden h-full">
          <ModeRouter panel="center" />
        </div>

        {/* Right Panel - Mode-specific content */}
        {isRightOpen && (
          <>
            <PanelResizer
              onResize={(delta) => setRightPanelWidth(rightPanelWidth - delta)}
              className="hidden lg:flex"
            />
            <div 
              className="hidden lg:flex flex-col shrink-0 h-full" 
              style={{ width: rightPanelWidth }}
            >
              <ModeRouter panel="right" />
            </div>
          </>
        )}
      </div>

      {/* Modals */}
      <DiffModal />
      <SettingsModal />
      <AccountModal />
      <ProjectModal />
      <CodeFileViewerModal />

      {/* Toast Notifications */}
      <Toaster />
    </div>
  );
};

export default App;
