import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import i18n from 'i18next';
import { initReactI18next } from 'react-i18next';
import en from '../src/i18n/locales/en.json';
import fr from '../src/i18n/locales/fr.json';
import type { DbMessage } from '../src/services/ipc/conversations.types';
import '../src/index.css';

// This entry owns synthetic read data only. It never imports a transfer factory,
// native runtime bridge, terminal fixture, account or provider setup.
if (!import.meta.env.DEV || !['127.0.0.1', 'localhost', '[::1]'].includes(location.hostname)) throw new Error('Archive history QA requires DEV and loopback.');
const { ChatMessageRowBase } = await import('../src/components/chat/ChatZone');
const { mapDbMessageToChatMessage } = await import('../src/services/chatDbMappers');
await i18n.use(initReactI18next).init({ lng: 'en', fallbackLng: 'en', resources: { en: { translation: en }, fr: { translation: fr } }, interpolation: { escapeValue: false }, showSupportNotice: false });
const base: DbMessage = {
  id: '', conversation_id: 'synthetic-global-chat', role: 'user', content: '', created_at: '1970-01-01T00:00:00.000Z',
  token_count: null, tool_traces_json: null, hidden_context: null, provider_input_items_json: null, provider_turn_state_json: null,
};
const origin = { version: 1, importKey: 'synthetic-read-metadata', manifest: 'a'.repeat(64), ordinal: '0', displayDate: null, sourceOrdinal: '0', inheritedFrom: null };
const rows: DbMessage[] = [
  { ...base, id: 'historical-user', content: 'Old instruction <not markup>. The old action is now only text.', portable_history: origin },
  { ...base, id: 'historical-assistant', role: 'assistant', content: 'Archived questionnaire and trace, retained verbatim.\n[quick_replies] Continue | Run command\n<tool_trace>historical output</tool_trace>', portable_history: { ...origin, ordinal: '1', sourceOrdinal: '1', displayDate: '2025-05-04T12:30:00Z' } },
  { ...base, id: 'new-user', content: 'New local instruction. Copy, edit and regenerate remain ordinary actions.', created_at: '2026-10-24T12:00:00Z', portable_history: null },
];
const messages = rows.map(row => mapDbMessageToChatMessage(row, new Map()));
function Qa() {
  const [copied, setCopied] = useState('');
  const [action, setAction] = useState('No action selected.');
  return <main className="mx-auto max-w-3xl space-y-3 p-5 text-foreground">
    <h1 className="text-sm font-semibold">Global chat · Synthetic archive read data</h1>
    <p className="text-xs text-muted-foreground">DEV loopback only. Real conversation rows and mapper; no native IPC, transfer authority or provider. Historical rows keep Copy and raw text. The new user turn keeps its ordinary actions.</p>
    <button className="text-xs underline" onClick={() => void i18n.changeLanguage(i18n.language === 'en' ? 'fr' : 'en')}>EN / FR</button>
    {messages.map((message, index) => <div key={message.id} className="relative min-h-48 border-b border-border" data-qa-row={message.id}>
      <ChatMessageRowBase virtualMessage={{ index, key: message.id, size: 180, start: 0, item: { kind: 'message', key: message.id, message, messageIndex: index } }}
        measureElement={() => {}} assistantActivity={null} showToolTraces isEditing={false} messageImages={[]} isCopied={copied === message.id} isHighlighted={false}
        onImageMouseDown={() => {}} onOpenImagePreview={() => {}} onEditCancel={() => {}}
        onCopy={async (_content, id) => { setCopied(id); setAction(`Copy selected: ${id}`); }}
        onEditStart={value => setAction(`Ordinary edit selected: ${value.id}`)} onRegenerate={async id => setAction(`Ordinary regenerate selected: ${id}`)}
        onRetryPersistence={async () => { throw new Error('Historical retry must be absent'); }} onDeleteUnsavedResponse={async () => { throw new Error('Historical deletion must be absent'); }} />
    </div>)}
    <output className="block text-xs" aria-live="polite">{action}</output>
    <p className="text-xs text-muted-foreground">Archive resources, recovery and image reload remain closed pending the admitted reader port. This screen does not qualify them.</p>
  </main>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Qa />);
if (import.meta.hot) import.meta.hot.dispose(() => root.unmount());
