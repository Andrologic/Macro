import React from 'react';
import {
  macroContributionRegistry,
  type MacroExtensionComposerContribution,
  type MacroExtensionModeContribution,
  type MacroExtensionViewContribution,
} from '../../services/extensions';
import { Icon } from '../ui/Icon';
import { ExtensionComposer } from '../extensions/ExtensionComposer';
import { ExtensionDetailsView } from '../extensions/ExtensionDetailsView';
import { ExtensionGraphView } from '../extensions/ExtensionGraphView';
import { ExtensionTableView } from '../extensions/ExtensionTableView';
import { ExtensionTreeView } from '../extensions/ExtensionTreeView';

interface ExtensionNativeViewsProps {
  mode: string;
  panel: 'left' | 'center' | 'right';
}

const getPanelViewId = (
  mode: MacroExtensionModeContribution,
  panel: 'left' | 'center' | 'right',
): string | null => mode.layout?.[panel] ?? null;

export const ExtensionNativeViews: React.FC<ExtensionNativeViewsProps> = ({
  mode,
  panel,
}) => {
  const modeEntry = macroContributionRegistry.getMode(mode);
  if (!modeEntry) {
    return <ExtensionEmptyPanel title="Extension mode unavailable" />;
  }

  const viewId = getPanelViewId(modeEntry.contribution, panel);
  const viewEntry = viewId ? macroContributionRegistry.getView(viewId) : null;
  const composerEntry = modeEntry.contribution.composer
    ? macroContributionRegistry.getComposer(modeEntry.contribution.composer)
    : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="min-h-0 flex-1">
        {viewEntry ? (
          <ExtensionViewRenderer
            extensionId={viewEntry.extensionId}
            view={viewEntry.contribution}
          />
        ) : (
          <ExtensionEmptyPanel title="Extension view unavailable" />
        )}
      </div>
      {panel === 'center' && composerEntry && (
        <ExtensionComposer composer={composerEntry.contribution} />
      )}
    </div>
  );
};

const ExtensionViewRenderer: React.FC<{
  extensionId: string;
  view: MacroExtensionViewContribution;
}> = ({ extensionId, view }) => {
  switch (view.kind) {
    case 'tree':
      return <ExtensionTreeView extensionId={extensionId} viewId={view.id} title={view.title} />;
    case 'graph':
      return <ExtensionGraphView extensionId={extensionId} viewId={view.id} title={view.title} />;
    case 'details':
      return <ExtensionDetailsView extensionId={extensionId} viewId={view.id} title={view.title} />;
    case 'table':
      return <ExtensionTableView extensionId={extensionId} viewId={view.id} title={view.title} />;
    default:
      return <ExtensionEmptyPanel title={view.title} />;
  }
};

const ExtensionEmptyPanel: React.FC<{ title: string }> = ({ title }) => (
  <div className="flex h-full items-center justify-center bg-card text-center">
    <div>
      <Icon name="layout-grid" size={32} className="mx-auto mb-3 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">{title}</p>
    </div>
  </div>
);

export type ExtensionNativeComposerContribution = MacroExtensionComposerContribution;
