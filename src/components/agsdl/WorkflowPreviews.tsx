import type { BlockDetail, BlockDetailKey } from '../../services/agsdl/blockDetails';
import { edgeDetails } from '../../services/agsdl/blockDetails';
import type { ViewerCard } from '../../services/agsdl/viewer';
import type { ViewerEdge } from '../../services/agsdl/graphLayout';
import { useAgsdlTranslation } from './useAgsdlTranslation';

// Expressions and arguments stay as written in the document.
const literal = new Set<BlockDetailKey>(['arguments', 'test', 'accept', 'action', 'targets', 'context']);
const transferKeys: Record<string, string> = {
  'message': 'message', 'resources.text · results': 'response', 'resources.result': 'result', 'resources.error': 'error', 'branches': 'results', 'Message': 'message', 'completion': 'response', 'data': 'result', 'members': 'results', 'error': 'error', 'current value': 'value',
  'resources.result ← text · text/plain': 'response', 'resources.result ← data · application/json': 'result',
  'resources.result ← members · application/json': 'results', 'resources.error ← error · application/json': 'error',
};

/** Hover preview of a block: its configuration only, never what the card already shows. */
export function WorkflowBlockPreview({ details, card }: { details: BlockDetail[]; card?: ViewerCard }) {
  const { t } = useAgsdlTranslation();
  const lead = details.find(detail => detail.key === 'instructions');
  const rows = details.filter(detail => detail.key !== 'instructions');
  const value = (detail: BlockDetail) => {
    if (detail.message030) return t(`agsdl.graph030.${detail.message030}`, detail.params030);
    if (card?.edition030) return detail.values.join(', ');
    if (detail.key === 'effect') return t(`agsdl.preview.effects.${detail.values[0]}`, { defaultValue: detail.values[0] });
    if (detail.key === 'limit') return t('agsdl.preview.limitValue', { count: Number(detail.values[0]) });
    if (detail.key === 'mode') return detail.values.map(item => t(`agsdl.preview.join.${item.replace('remaining: ', 'remaining-')}`, { defaultValue: item })).join(', ');
    return detail.values.join(literal.has(detail.key) || detail.key === 'model' ? ' ; ' : ', ');
  };
  const renderRows = (items: BlockDetail[]) => <dl className="agsdl-preview-list">
    {items.map((detail, index) => <div key={`${detail.key}-${index}`}>
      <dt>{t(detail.message030 ? `agsdl.graph030.labels.${detail.message030.split(".")[0]}` : `agsdl.preview.${detail.key}`)}</dt>
      <dd className={!detail.message030 && literal.has(detail.key) ? 'is-literal' : undefined}>{value(detail)}</dd>
    </div>)}
  </dl>;
  if (card?.edition030) return <div className="agsdl-preview">
    {lead && <p className="agsdl-preview-lead">{lead.values[0]}</p>}
    {renderRows(rows.filter(detail => !detail.advanced))}
    <details className="agsdl-preview-advanced">
      <summary>{t('agsdl.graph030.advanced')}</summary>
      {renderRows(rows.filter(detail => detail.advanced))}
      <small>{t('agsdl.graph030.declaredOnly')}</small>
      {card.promptSources?.length ? <section><small>{t('agsdl.instructions')}</small>{card.promptSources.map((source, index) =>
        <pre key={index} tabIndex={0} className="agsdl-source-value">{source.text ?? source.uri ?? source.valueJson}</pre>)}</section> : null}
      <pre tabIndex={0} className="agsdl-source-value">{card.edition030.sourceJson}</pre>
      {card.edition030.definitionJson && card.edition030.definitionJson !== card.edition030.sourceJson && <pre tabIndex={0} className="agsdl-source-value">{card.edition030.definitionJson}</pre>}
    </details>
  </div>;
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
  const when = connection.route030?.inherited ? t('agsdl.graph030.error.inheritedRoute') : details.route === 'choice' ? t('agsdl.preview.when.choice', { who: sourcePerformer ?? sourceTitle, name: details.choice })
    : details.route === 'error' ? t('agsdl.preview.when.error', { source: sourceTitle })
      : t(`agsdl.preview.when.${details.route}`);
  const transmits = [...new Set(details.transmits.map(name => transferKeys[name] ? t(`agsdl.link.payload.${transferKeys[name]}`) : name))];
  return <div className="agsdl-preview">
    <dl className="agsdl-preview-list">
      <div><dt>{t('agsdl.preview.whenLabel')}</dt><dd>{when}</dd></div>
      {connection.route030?.eachJson !== undefined && <div><dt>{t('agsdl.graph030.repetition')}</dt><dd>{t('agsdl.graph030.fanout')}</dd></div>}
      {connection.route030?.via?.length ? <div><dt>{t('agsdl.graph030.provenance')}</dt><dd>{t('agsdl.graph030.routeVia')}</dd></div> : null}
      {transmits.length > 0 && <div><dt>{t('agsdl.preview.transmits')}</dt><dd>{transmits.join(', ')}</dd></div>}
    </dl>
  </div>;
}
