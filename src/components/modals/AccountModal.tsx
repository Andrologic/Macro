import React from 'react';
import { useTranslation } from 'react-i18next';
import { useAppStore } from '../../stores/useAppStore';
import { useAuthStore } from '../../stores/useAuthStore';
import { Icon } from '../ui/Icon';
import { Button } from '../ui/Button';
import { toast } from '../ui/Toaster';

export const AccountModal: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { accountOpen, closeAccount } = useAppStore();
  const { user, logout, isLoading } = useAuthStore();

  if (!accountOpen || !user) return null;

  const handleLogout = async () => {
    try {
      await logout();
      toast.success(t('toast.loggedOut'));
      closeAccount();
    } catch (error) {
      console.error('Failed to logout:', error);
      toast.error(t('errors.logoutFailed'));
    }
  };

  const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString(i18n.language, {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="w-[480px] max-h-[85vh] bg-card border border-border rounded-2xl shadow-2xl overflow-hidden flex flex-col">
        <header className="h-12 px-4 border-b border-border flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Icon name="user" size={16} className="text-primary" />
            <span className="text-sm text-foreground">{t('account.title')}</span>
          </div>
          <button
            onClick={closeAccount}
            className="p-1.5 rounded-lg hover:bg-accent transition-colors"
            aria-label={t('common.close')}
          >
            <Icon name="x" size={14} className="text-muted-foreground" />
          </button>
        </header>

        <div className="flex-1 overflow-y-auto p-4 space-y-6">
          {/* Profile Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t('account.profile')}
            </h3>
            
            <div className="bg-card/50 rounded-lg p-4">
              {/* Avatar */}
              <div className="flex items-center gap-4 mb-4">
                <div className="w-16 h-16 rounded-full bg-gradient-to-br from-primary to-primary/70 flex items-center justify-center">
                  <span className="text-2xl font-semibold text-white">
                    {user.name.charAt(0).toUpperCase()}
                  </span>
                </div>
                <div>
                  <h4 className="text-lg font-semibold text-foreground">{user.name}</h4>
                  <p className="text-sm text-muted-foreground">{user.email}</p>
                </div>
              </div>

              {/* User Details */}
              <div className="space-y-2">
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{t('account.userId')}</span>
                  <span className="text-foreground font-mono">{user.id}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{t('account.memberSince')}</span>
                  <span className="text-foreground">{formatDate(user.created_at)}</span>
                </div>
                <div className="flex justify-between text-xs">
                  <span className="text-muted-foreground">{t('account.lastUpdated')}</span>
                  <span className="text-foreground">{formatDate(user.updated_at)}</span>
                </div>
              </div>
            </div>
          </section>

          {/* Preferences Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t('account.currentPreferences')}
            </h3>
            
            <div className="bg-card/50 rounded-lg p-4 space-y-3">
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('settings.theme')}</span>
                <span className="text-foreground capitalize">{user.preferences.theme}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('settings.language')}</span>
                <span className="text-foreground uppercase">{user.preferences.language}</span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('account.inAppNotifications')}</span>
                <span className={user.preferences.notifications ? 'text-green-400' : 'text-red-400'}>
                  {user.preferences.notifications ? t('common.enabled') : t('common.disabled')}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span className="text-muted-foreground">{t('account.emailUpdates')}</span>
                <span className={user.preferences.emailUpdates ? 'text-green-400' : 'text-red-400'}>
                  {user.preferences.emailUpdates ? t('common.enabled') : t('common.disabled')}
                </span>
              </div>
            </div>
          </section>

          {/* Quick Actions Section */}
          <section>
            <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
              {t('account.quickActions')}
            </h3>
            
            <div className="space-y-2">
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-start"
                leftIcon={<Icon name="shield" size={16} />}
              >
                {t('account.changePassword')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-start"
                leftIcon={<Icon name="tool" size={16} />}
              >
                {t('account.manageApiKeys')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                className="w-full justify-start"
                leftIcon={<Icon name="download" size={16} />}
              >
                {t('account.exportData')}
              </Button>
            </div>
          </section>

          {/* Danger Zone */}
          <section>
            <h3 className="text-xs font-semibold text-red-400 uppercase tracking-wider mb-3">
              {t('account.dangerZone')}
            </h3>
            
            <Button
              variant="error"
              size="sm"
              className="w-full justify-start"
              leftIcon={<Icon name="alert-circle" size={16} />}
              onClick={handleLogout}
              isLoading={isLoading}
            >
              {t('account.signOut')}
            </Button>
          </section>
        </div>

        <footer className="h-12 border-t border-border px-4 flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={closeAccount}>
            {t('common.close')}
          </Button>
        </footer>
      </div>
    </div>
  );
};

// Export both named and default for lazy loading compatibility
export default AccountModal;
