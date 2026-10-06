import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { McpElicitationAction, McpElicitationAnswer } from '../../types/generated/ipc';
import {
  mcpFormHost,
  type FormHostIssue,
  type FormHostSnapshot,
  type McpFormHost,
  type QueuedFormRequest,
} from '../../services/mcp/formHost';
import {
  initialFormDraft,
  validateFormDraft,
  type FormDraft,
  type FormError,
  type FormField,
} from '../../services/mcp/formElicitation';
import { Dialog } from '../ui/Dialog';

const controlClass = 'min-h-8 w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm text-foreground focus:outline-none focus:ring-2 focus:ring-primary/50';
const buttonClass = 'rounded-md border border-border px-3 py-1.5 text-xs font-medium text-foreground hover:bg-accent disabled:cursor-not-allowed disabled:opacity-50';

function issueText(issue: FormHostIssue, t: ReturnType<typeof useTranslation>['t']): string {
  switch (issue) {
    case 'portBusy': return t('mcpForm.portBusy', 'Another MCP form host is connected.');
    case 'hostUnavailable': return t('mcpForm.hostUnavailable', 'The MCP form host is unavailable.');
    case 'expired': return t('mcpForm.expired', 'The MCP form request expired. Its values were discarded.');
    case 'cancelled': return t('mcpForm.cancelled', 'This MCP form request is no longer active.');
    case 'invalid': return t('mcpForm.invalidResponse', 'The server rejected these values. Review the form and try again.');
    case 'failed': return t('mcpForm.sendFailed', 'Could not send the form response. Try again or decline.');
  }
}

function errorText(error: FormError, t: ReturnType<typeof useTranslation>['t']): string {
  switch (error) {
    case 'required': return t('mcpForm.required', 'This field is required.');
    case 'minimum': return t('mcpForm.minimum', 'The value is below the allowed minimum.');
    case 'maximum': return t('mcpForm.maximum', 'The value is above the allowed maximum.');
    case 'choice': return t('mcpForm.choice', 'Choose one of the listed options.');
    case 'duplicate': return t('mcpForm.duplicate', 'Choose each option only once.');
    case 'invalid': return t('mcpForm.invalidValue', 'Enter a valid value.');
  }
}

function constraintText(field: FormField, t: ReturnType<typeof useTranslation>['t']): string {
  const parts: string[] = [];
  if (field.minLength !== undefined) parts.push(t('mcpForm.minLength', 'At least {{count}} characters', { count: field.minLength }));
  if (field.maxLength !== undefined) parts.push(t('mcpForm.maxLength', 'At most {{count}} characters', { count: field.maxLength }));
  if (field.minimum !== undefined) parts.push(t('mcpForm.minValue', 'Minimum: {{value}}', { value: field.minimum }));
  if (field.maximum !== undefined) parts.push(t('mcpForm.maxValue', 'Maximum: {{value}}', { value: field.maximum }));
  if (field.minItems !== undefined) parts.push(t('mcpForm.minItems', 'Select at least {{count}}', { count: field.minItems }));
  if (field.maxItems !== undefined) parts.push(t('mcpForm.maxItems', 'Select at most {{count}}', { count: field.maxItems }));
  if (field.format) parts.push(t('mcpForm.format', 'Format: {{format}}', { format: field.format }));
  return parts.join(' · ');
}

function FormControl({ field, value, error, onChange, idPrefix }: {
  field: FormField;
  idPrefix: string;
  value: string | string[] | undefined;
  error?: FormError;
  onChange: (value: string | string[] | undefined) => void;
}) {
  const { t } = useTranslation();
  const fieldId = `${idPrefix}-${field.name}`;
  const selected = Array.isArray(value) ? value : [];
  return (
    <div className="space-y-1.5">
      <label htmlFor={fieldId} className="block text-xs font-medium text-foreground">
        {field.label}{field.required ? ' *' : ''}
      </label>
      {field.description && <p className="text-xs text-muted-foreground">{field.description}</p>}
      {field.kind === 'array' ? (
        <div id={fieldId} className="flex flex-wrap gap-2" role="group" aria-label={field.label}>
          {field.choices?.map((choice) => (
            <label key={choice.value} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1.5 text-xs">
              <input type="checkbox" checked={selected.includes(choice.value)} onChange={(event) => {
                onChange(event.target.checked
                  ? [...selected, choice.value]
                  : selected.filter((item) => item !== choice.value));
              }} />
              {choice.label}
            </label>
          ))}
        </div>
      ) : field.choices ? (
        <select id={fieldId} className={controlClass}
          value={field.choices.findIndex((choice) => choice.value === value) >= 0
            ? String(field.choices.findIndex((choice) => choice.value === value)) : ''}
          onChange={(event) => onChange(event.target.value === '' ? undefined : field.choices?.[Number(event.target.value)]?.value)}>
          <option value="">{t('mcpForm.choose', 'Choose an option')}</option>
          {field.choices.map((choice, index) => <option key={index} value={index}>{choice.label}</option>)}
        </select>
      ) : field.kind === 'boolean' ? (
        <select id={fieldId} className={controlClass} value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value || undefined)}>
          <option value="">{t('mcpForm.choose', 'Choose an option')}</option>
          <option value="true">{t('mcpForm.yes', 'Yes')}</option>
          <option value="false">{t('mcpForm.no', 'No')}</option>
        </select>
      ) : (
        <input id={fieldId} className={controlClass}
          type={field.kind === 'number' || field.kind === 'integer' ? 'number'
            : field.format === 'email' ? 'email' : field.format === 'uri' ? 'url'
              : field.format === 'date' ? 'date' : 'text'}
          step={field.kind === 'integer' ? '1' : field.kind === 'number' ? 'any' : undefined}
          min={field.minimum} max={field.maximum} maxLength={field.maxLength}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          autoComplete="off" spellCheck={false}
        />
      )}
      {constraintText(field, t) && <p className="text-[11px] text-muted-foreground">{constraintText(field, t)}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{errorText(error, t)}</p>}
    </div>
  );
}

function FormEditor({ item, host, submitting, waiting, issue }: {
  item: QueuedFormRequest;
  host: McpFormHost;
  submitting: boolean;
  waiting: QueuedFormRequest[];
  issue: FormHostIssue | null;
}) {
  const { t } = useTranslation();
  const [drafts, setDrafts] = useState<FormDraft[]>(() =>
    item.forms.map((form) => form ? initialFormDraft(form) : Object.create(null)));
  const [errors, setErrors] = useState<Array<Record<string, FormError>>>(() => item.forms.map(() => Object.create(null)));
  const [reviewing, setReviewing] = useState(false);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, []);
  const secondsLeft = Math.max(0, Math.ceil((item.request.expiresAtMs - now) / 1_000));
  const canAccept = item.forms.every((form) => form && !form.blockedForSecrets);

  const updateField = (index: number, name: string, value: string | string[] | undefined) => {
    setDrafts((previous) => previous.map((draft, i) => {
      if (i !== index) return draft;
      const next: FormDraft = Object.assign(Object.create(null), draft);
      if (value === undefined) delete next[name];
      else next[name] = value;
      return next;
    }));
    setErrors((previous) => previous.map((group, i) => {
      if (i !== index) return group;
      const next: Record<string, FormError> = Object.assign(Object.create(null), group);
      delete next[name];
      return next;
    }));
  };

  const validate = () => {
    const results = item.forms.map((form, index) => form ? validateFormDraft(form, drafts[index] ?? {}) : null);
    setErrors(results.map((result) => result?.errors ?? Object.create(null)));
    return results.every((result) => result?.content) ? results : null;
  };

  const respond = (action: McpElicitationAction) => {
    let answers: McpElicitationAnswer[];
    if (action === 'accept') {
      const results = validate();
      if (!results) { setReviewing(false); return; }
      answers = item.request.prompts.map((prompt, index) => ({
        id: prompt.id, action, content: results[index]?.content ?? null,
      }));
    } else {
      answers = item.request.prompts.map((prompt) => ({ id: prompt.id, action, content: null }));
    }
    void host.answer(item.request.requestId, answers);
  };

  return (
    <Dialog title={t('mcpForm.title', 'MCP form request')} onClose={() => { if (!submitting) respond('cancel'); }}
      backdropClassName="fixed inset-0 z-[14000] flex items-center justify-center bg-black/70 p-4">
      <div className="flex max-h-[calc(100vh-2rem)] w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-border bg-card text-foreground shadow-2xl">
        <header className="shrink-0 border-b border-border px-4 py-3">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">{t('mcpForm.title', 'MCP form request')}</h2>
            <span className="rounded bg-muted px-2 py-1 text-xs tabular-nums">
              {t('mcpForm.expiresIn', 'Expires in {{count}} s', { count: secondsLeft })}
            </span>
          </div>
          <p className="mt-1 text-xs text-muted-foreground">
            {t('mcpForm.server', 'Server')}: <strong className="text-foreground">{item.request.key.serverId}</strong>
            <span className="mx-2">·</span>{t('mcpForm.operation', 'Operation')}: {item.request.operationId}
          </p>
          {waiting.length > 0 && <p className="mt-1 text-xs text-muted-foreground">
            {t('mcpForm.queued', '{{count}} MCP requests waiting', { count: waiting.length })}:
            {' '}{waiting.map((queued) => queued.request.key.serverId).join(', ')}
          </p>}
        </header>
        <div className="min-h-0 space-y-5 overflow-y-auto px-4 py-4">
          {issue && <p role="alert" className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-xs text-destructive">
            {issueText(issue, t)}
          </p>}
          <p className="rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-xs text-foreground">
            {t('mcpForm.privacy', 'Review every value before sending it to this server. Never enter passwords, tokens, API keys or other secrets.')}
          </p>
          {item.forms.map((form, index) => (
            <section key={item.request.prompts[index]?.id ?? index} className="space-y-3 border-b border-border pb-4 last:border-0">
              {!form ? (
                <p role="alert" className="text-sm text-destructive">
                  {t('mcpForm.unsupported', 'This server sent a form Macro cannot display. You can decline or cancel it.')}
                </p>
              ) : form.blockedForSecrets ? (
                <p role="alert" className="text-sm text-destructive">
                  {t('mcpForm.secretBlocked', 'This form appears to ask for a secret. Macro will not collect it here. Decline or cancel the request.')}
                </p>
              ) : (
                <>
                  {form.title && <h3 className="text-sm font-medium">{form.title}</h3>}
                  <p className="text-sm">{form.message}</p>
                  {form.description && <p className="text-xs text-muted-foreground">{form.description}</p>}
                  {reviewing ? (
                    <dl className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-4 gap-y-2 text-xs">
                      {form.fields.map((field) => {
                        const value = drafts[index]?.[field.name];
                        return <div key={field.name} className="contents">
                          <dt className="font-medium">{field.label}</dt>
                          <dd className="break-all">{value === undefined ? t('mcpForm.omitted', 'Not provided')
                            : Array.isArray(value) ? value.map((entry) => field.choices?.find((choice) => choice.value === entry)?.label ?? entry).join(', ')
                              : field.choices?.find((choice) => choice.value === value)?.label ??
                                (field.kind === 'boolean' ? value === 'true' ? t('mcpForm.yes', 'Yes') : t('mcpForm.no', 'No') : value)}</dd>
                        </div>;
                      })}
                    </dl>
                  ) : form.fields.length ? (
                    <div className="space-y-4">
                      {form.fields.map((field) => <FormControl key={field.name} field={field}
                        idPrefix={`mcp-${item.request.requestId}-${index}`}
                        value={drafts[index]?.[field.name]} error={errors[index]?.[field.name]}
                        onChange={(value) => updateField(index, field.name, value)} />)}
                    </div>
                  ) : <p className="text-xs text-muted-foreground">{t('mcpForm.noFields', 'This form has no fields.')}</p>}
                </>
              )}
            </section>
          ))}
        </div>
        <footer className="flex flex-wrap items-center justify-end gap-2 border-t border-border px-4 py-3">
          <button type="button" className={buttonClass} disabled={submitting} onClick={() => respond('cancel')}>
            {t('mcpForm.cancel', 'Cancel')}
          </button>
          <button type="button" className={buttonClass} disabled={submitting} onClick={() => respond('decline')}>
            {t('mcpForm.decline', 'Decline')}
          </button>
          {canAccept && (reviewing ? <>
            <button type="button" className={buttonClass} disabled={submitting} onClick={() => setReviewing(false)}>
              {t('mcpForm.edit', 'Edit values')}
            </button>
            <button type="button" className={`${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
              disabled={submitting || secondsLeft === 0} onClick={() => respond('accept')}>
              {t('mcpForm.send', 'Send reviewed values')}
            </button>
          </> : <button type="button" className={`${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`}
            disabled={submitting || secondsLeft === 0} onClick={() => { if (validate()) setReviewing(true); }}>
            {t('mcpForm.review', 'Review values')}
          </button>)}
        </footer>
      </div>
    </Dialog>
  );
}

export function McpFormHostView({ host = mcpFormHost }: { host?: McpFormHost }) {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<FormHostSnapshot>(() => host.snapshot());
  useEffect(() => {
    const unsubscribe = host.subscribe(() => setSnapshot(host.snapshot()));
    const unmount = host.mount();
    setSnapshot(host.snapshot());
    return () => { unsubscribe(); unmount(); };
  }, [host]);
  const active = snapshot.queue[0];
  return <>
    {snapshot.issue && !active && <Dialog title={t('mcpForm.title', 'MCP form request')}
      onClose={() => host.dismissIssue()}
      backdropClassName="fixed inset-0 z-[14010] flex items-center justify-center bg-black/60 p-4">
      <div role="alert" className="flex max-w-sm items-center gap-3 rounded-lg border border-border bg-card p-3 text-xs text-foreground shadow-xl">
        <span>{issueText(snapshot.issue, t)}</span>
        {snapshot.status === 'unavailable' && <button type="button" className={buttonClass} onClick={() => void host.retry()}>
          {t('mcpForm.retry', 'Retry')}
        </button>}
        <button type="button" aria-label={t('mcpForm.dismiss', 'Dismiss')} className={buttonClass} onClick={() => host.dismissIssue()}>×</button>
      </div>
    </Dialog>}
    {active && <>
      <FormEditor key={active.request.requestId} item={active} host={host}
        waiting={snapshot.queue.slice(1)} issue={snapshot.issue}
        submitting={snapshot.submittingId === active.request.requestId} />
    </>}
  </>;
}
