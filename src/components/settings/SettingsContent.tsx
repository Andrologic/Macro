import React, { lazy, Suspense } from 'react';
import { useTranslation } from 'react-i18next';
import type { SettingsContribution } from '../../composition/settings/registry';

const createView = (contribution: SettingsContribution): React.ComponentType =>
  contribution.component ?? lazy(contribution.load);

interface ContentProps {
  contribution: SettingsContribution;
  retryLabel: string;
  errorLabel: string;
  loadingLabel: string;
}

interface ContentState {
  contribution: SettingsContribution;
  view: React.ComponentType;
  failed: boolean;
}

/** An import failure stays inside the content area; navigation and close remain usable. */
class SettingsContentBoundary extends React.Component<ContentProps, ContentState> {
  state: ContentState = {
    contribution: this.props.contribution,
    view: createView(this.props.contribution),
    failed: false,
  };

  static getDerivedStateFromProps(props: ContentProps, state: ContentState): ContentState | null {
    if (props.contribution === state.contribution) return null;
    return { contribution: props.contribution, view: createView(props.contribution), failed: false };
  }

  static getDerivedStateFromError(): Partial<ContentState> {
    return { failed: true };
  }

  private retry = () => {
    // React.lazy caches rejection. A fresh lazy type calls the loader again.
    this.setState({ view: createView(this.props.contribution), failed: false });
  };

  render() {
    if (this.state.failed) {
      return (
        <div role="alert" className="space-y-3 rounded-lg border border-border bg-card p-4">
          <p className="text-sm text-muted-foreground">{this.props.errorLabel}</p>
          <button type="button" onClick={this.retry} className="rounded border border-border px-3 py-1.5 text-sm hover:bg-accent">
            {this.props.retryLabel}
          </button>
        </div>
      );
    }
    const View = this.state.view;
    return (
      <Suspense fallback={<p role="status" className="text-sm text-muted-foreground">{this.props.loadingLabel}</p>}>
        <View />
      </Suspense>
    );
  }
}

export const SettingsContent: React.FC<{ contribution: SettingsContribution }> = ({ contribution }) => {
  const { t } = useTranslation();
  return (
    <SettingsContentBoundary
      contribution={contribution}
      errorLabel={t('common.error', 'Error')}
      retryLabel={t('common.retry', 'Retry')}
      loadingLabel={t('common.loading', 'Loading...')}
    />
  );
};
