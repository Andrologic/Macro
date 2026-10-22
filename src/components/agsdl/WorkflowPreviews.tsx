import type { BlockDetail, BlockDetailKey } from '../../services/agsdl/blockDetails';
import { edgeDetails } from '../../services/agsdl/blockDetails';
import type { ViewerEdge } from '../../services/agsdl/graphLayout';
import { useAgsdlTranslation } from './useAgsdlTranslation';

// Expressions and arguments stay as written in the document.
const literal = new Set<BlockDetailKey>(['arguments', 'test', 'accept']);
const transferKeys: Record<string, string> = {
  'Message': 'message', 'completion': 'response', 'data': 'result', 'members': 'results', 'error': 'error', 'current value': 'value',
  'resources.result ← text · text/plain': 'response', 'resources.result ← data · application/json': 'result',
  'resources.result ← members · application/json': 'results', 'resources.error ← error · application/json': 'error',
};

/** Hover preview of a block: its configuration only, never what the card already shows. */
export function WorkflowBlockPreview({ details }: { details: BlockDetail[] }) {
  const { t } = useAgsdlTranslation();
  const lead = details.find(detail => detail.key === 'instructions');
  const rows = details.filter(detail => detail.key !== 'instructions');
  const value = (detail: BlockDetail) => {
    if (detail.key === 'effect') return t(`agsdl.preview.effects.${detail.values[0]}`, { defaultValue: detail.values[0] });
    if (detail.key === 'limit') return t('agsdl.preview.limitValue', { count: Number(detail.values[0]) });
    if (detail.key === 'mode') return detail.values.map(item => t(`agsdl.preview.join.${item.replace('remaining: ', 'remaining-')}`, { defaultValue: item })).join(', ');
    return detail.values.join(literal.has(detail.key) || detail.key === 'model' ? ' ; ' : ', ');
  };
  return <div className="agsdl-preview">
    {lead && <p className="agsdl-preview-lead">{lead.values[0]}</p>}
    {rows.length > 0 && <dl className="agsdl-preview-list">
      {rows.map(detail => <div key={detail.key}>
        <dt>{t(`agsdl.preview.${detail.key}`)}</dt>
        <dd className={literal.has(detail.key) ? 'is-literal' : undefined}>{value(detail)}</dd>
      </div>)}
    </dl>}
  </div>;
}

/** Hover preview of a connection: when it is taken and what it delivers, never its ends. */
export function WorkflowEdgePreview({ connection, sourceTitle, sourcePerformer }: { connection: ViewerEdge; sourceTitle: string; sourcePerformer?: string }) {
  const { t } = useAgsdlTranslation();
  const details = edgeDetails(connection);
  const when = details.route === 'choice' ? t('agsdl.preview.when.choice', { who: sourcePerformer ?? sourceTitle, name: details.choice })
    : details.route === 'error' ? t('agsdl.preview.when.error', { source: sourceTitle })
      : t(`agsdl.preview.when.${details.route}`);
  const transmits = [...new Set(details.transmits.map(name => transferKeys[name] ? t(`agsdl.link.payload.${transferKeys[name]}`) : name))];
  return <div className="agsdl-preview">
    <dl className="agsdl-preview-list">
      <div><dt>{t('agsdl.preview.whenLabel')}</dt><dd>{when}</dd></div>
      {transmits.length > 0 && <div><dt>{t('agsdl.preview.transmits')}</dt><dd>{transmits.join(', ')}</dd></div>}
    </dl>
  </div>;
}
