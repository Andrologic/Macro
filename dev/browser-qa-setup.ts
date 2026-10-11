import { workspaceGetBootstrap, workspaceGetActiveRoot, createProviderConfig, registerManualModel, createConversation, importMessages, listConversations } from '../src/services/tauriIpc';
if (!import.meta.env.DEV || import.meta.env.VITE_MACRO_BROWSER_QA !== '1' || location.origin !== 'http://127.0.0.1:1426') throw new Error('Isolated browser QA only');
const status = document.querySelector<HTMLPreElement>('#status')!;
const seed = document.querySelector<HTMLButtonElement>('#seed')!;
async function verify() {
  const [bootstrap, root, conversations] = await Promise.all([workspaceGetBootstrap(), workspaceGetActiveRoot(), listConversations()]);
  const empty = bootstrap.standaloneProjects.length === 0 && bootstrap.projectGroups.length === 0 && !bootstrap.plan && conversations.length === 0;
  status.textContent = JSON.stringify({ workspace: root, projects: bootstrap.standaloneProjects.length, groups: bootstrap.projectGroups.length, conversations: conversations.length, isolated: empty }, null, 2);
  if (!empty || !root.endsWith('/browser-integration-20261009/workspace')) throw new Error('Refusing to seed a nonempty or unrelated workspace');
  seed.disabled = false;
}
seed.onclick = async () => {
  seed.disabled = true;
  try {
    const provider = await createProviderConfig({ name: 'Fournisseur local de validation', providerType: 'openai', baseUrl: 'http://127.0.0.1:4176/__qa/ai/v1', isLocal: true });
    await registerManualModel({providerId: provider.id, modelId: 'qa-local', name: 'Modèle local de validation'});
    for (const title of ['Conversation de validation', 'Historique paginé']) {
      const conversation = await createConversation({ title, scopeMode: 'Chat', providerId: provider.id, modelId: 'qa-local' });
      await importMessages(conversation.id, Array.from({length: title.includes('Historique') ? 85 : 2}, (_, i) => ({
        id: crypto.randomUUID(), turn_id: null, role: i % 2 ? 'assistant' : 'user',
        content: i % 2 ? `Réponse **locale** numéro ${i + 1}.` : `Message de validation numéro ${i + 1}.`,
        created_at: new Date(Date.now() - (100 - i) * 60000).toISOString(), completion_reason: i % 2 ? 'completed' : null,
      })));
    }
    status.textContent = 'Deux conversations créées dans la base desktop isolée. Ouvrez Macro pour activer le producteur et les voir sur le mobile.';
  } catch (error) { status.textContent = String(error); }
};
void verify().catch(error => { status.textContent = String(error); });
