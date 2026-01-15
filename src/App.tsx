import React from 'react';
import { Header } from './components/layout/Header';
import { LeftPanel } from './components/layout/LeftPanel';
import { ChatZone } from './components/chat/ChatZone';
import { RightPanel } from './components/layout/RightPanel';
import { useAppStore } from './stores/useAppStore';

const App: React.FC = () => {
  useAppStore();

  return (
    <div className="h-screen w-screen bg-background grid grid-rows-[48px_1fr] overflow-hidden">
      {/* Header */}
      <Header />

      {/* Main Content Area */}
      <div className="flex overflow-hidden">
        {/* Left Panel - Projects */}
        <LeftPanel />

        {/* Center - Chat Zone */}
        <ChatZone />

        {/* Right Panel - Git Trees */}
        <RightPanel />
      </div>
    </div>
  );
};

export default App;
