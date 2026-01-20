import React from 'react';
import { useAppStore } from '../../stores/useAppStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';

export const AccountModal: React.FC = () => {
  const { accountOpen, closeAccount } = useAppStore();
  const { user, logout, isLoading } = useAuthStore();

  if (!accountOpen || !user) return null;

  const handleLogout = async () => {
    try {
      await logout();
      closeAccount();
    } catch (error) {
      console.error('Failed to logout:', error);
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-h-[85vh] bg-zinc-950 border border-zinc-800 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-12 px-4 border-b border-zinc-800 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="user" size={16} className="text-indigo-400" />
            <span className="text-sm text-zinc-200">Account</span>
          </div>
          <button
            onClick={closeAccount}
            className="p-1.5 rounded-lg hover:bg-zinc-900 transition-colors"
          >
            <Icon name="x" size={14} className="text-zinc-500" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Profile Section */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Profile
            </h3>
            
            <div className="bg-zinc-800/50 rounded-lg p-4">
              {/* Avatar */}
              <div className="flex items-center gap-4 mb-4">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                  <span className="text-2xl font-semibold text-white">
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h4 className="text-lg font-semibold text-zinc-100">{user.name}</h4>
                  <p className="text-sm text-zinc-400">{user.email}</p>
                </div>
              </div>

              {/* User Details */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">User ID</span>
                  <span className="text-zinc-300 font-mono">{user.id}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Member since</span>
                  <span className="text-zinc-300">{formatDate(user.created_at)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-zinc-500">Last updated</span>
                  <span className="text-zinc-300">{formatDate(user.updated_at)}</span>
                </div>
              </div>
            </div>
          </section>

          {/* Preferences Section */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Current Preferences
            </h3>
            
            <div className="bg-zinc-800/50 rounded-lg p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Theme</span>
                <span className="text-zinc-200 capitalize">{user.preferences.theme}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Language</span>
                <span className="text-zinc-200 uppercase">{user.preferences.language}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">In-app notifications</span>
                <span className={user.preferences.notifications ? 'text-green-400' : 'text-red-400'}>
                  {user.preferences.notifications ? 'Enabled' : 'Disabled'}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-zinc-400">Email updates</span>
                <span className={user.preferences.emailUpdates ? 'text-green-400' : 'text-red-400'}>
                  {user.preferences.emailUpdates ? 'Enabled' : 'Disabled'}
                </span>
              </div>
            </div>
          </section>

          {/* Quick Actions Section */}
          <section>
            <h3 className="text-xs font-semibold text-zinc-400 uppercase tracking-wider mb-3">
              Quick Actions
            </h3>
            
            <div className="space-y-2">
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-start"
                leftIcon={<Icon name="shield" size={16} />}
              >
                Change password
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-start"
                leftIcon={<Icon name="tool" size={16} />}
              >
                Manage API keys
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-start"
                leftIcon={<Icon name="download" size={16} />}
              >
                Export data
              </Button>
            </div>
          </section>

          {/* Danger Zone */}
          <section>
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-3">
              Danger Zone
            </h3>
            
            <Button
              variant="error"
              size="sm"
              className="w-full justify-start"
              leftIcon={<Icon name="alert-circle" size={16} />}
              onClick={handleLogout}
              isLoading={isLoading}
            >
              Sign out
            </Button>
          </section>
        </div>

        <footer className="h-12 border-t border-zinc-800 px-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={closeAccount}>
            Close
          </Button>
        </footer>
      </div>
    </div>
  );
};
