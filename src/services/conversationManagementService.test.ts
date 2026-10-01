import { afterAll, beforeEach, expect, test, mock } from 'bun:test';
import { installTauriRuntimeMock, removeTauriRuntimeMock } from '../test-utils/tauriRuntime';
import type { DbConversation, DbMessage, ConversationMetadata } from './tauriIpc';
import { acknowledgeDisplayedConversation, persistConversationArchives } from './conversationManagementService';
import { mapDbConversationToConversation } from './chatDbMappers';
import { useChatStore } from '../stores/useChatStore';
import { useConversationArchiveStore } from '../stores/useConversationArchiveStore';
const c: DbConversation = {id:'synthetic-chat',title:'Synthetic',description:null,scope_mode:'Chat',task_id:null,project_id:null,group_id:null,provider_id:null,model_id:null,reasoning_effort:null,created_at:'2026-01-01T00:00:00Z',updated_at:'2026-01-01T00:00:00Z',last_message:null,message_count:0,is_pinned:false};
let conversations: DbConversation[]=[];let metadata: ConversationMetadata[]=[];let messages: DbMessage[]=[];
let revision=1;const calls: string[]=[];let beforeVersion: (()=>void)|undefined;
const invoke=mock(async (command:string,args:Record<string,unknown>={})=>{
  calls.push(command);
  if(command==='db_list_conversations')return structuredClone(conversations);
  if(command==='db_conversation_metadata')return structuredClone(metadata);
  if(command==='db_get_message')return structuredClone(messages.find(m=>m.id===args.messageId)??null);
  if(command==='db_conversation_response_version'){beforeVersion?.();const m=messages.find(m=>m.id===args.messageId);if(!m||m.content!==args.content)throw new Error('stale_revision');return revision;}
  if(command==='db_conversation_acknowledge'){const s=metadata.find(m=>m.conversation_id===args.conversationId)!;s.read_revision=Math.max(s.read_revision,...(args.observed as number[]));return;}
  if(command==='db_conversation_set_archives'){for(const id of args.ids as string[]){const state=metadata.find(m=>m.conversation_id===id)!;if(state.archived!==args.archived){state.archived=args.archived as boolean;state.revision++;}}return;}
  if(command==='db_conversation_action'){const input=args.input as {conversation_id:string;action:string;expected_revision:number};const s=metadata.find(m=>m.conversation_id===input.conversation_id)!;if(s.revision!==input.expected_revision)throw new Error('stale_revision');s.archived=input.action==='archive';s.revision++;return {outcome:'applied',conversation_id:s.conversation_id,revision:s.revision};}
  throw new Error(`Unexpected synthetic IPC ${command}`);
});
beforeEach(()=>{
  conversations=[structuredClone(c)];metadata=[{conversation_id:c.id,revision:1,archived:false,response_revision:1,read_revision:0,pending_tool:false,provider_failed:false,question_message_id:null,preview_message_id:null}];
  messages=[{id:'synthetic-answer',conversation_id:c.id,role:'assistant',content:'Observed',created_at:c.created_at,token_count:null,hidden_context:null,tool_traces_json:null,provider_input_items_json:null,provider_turn_state_json:null,completion_reason:'completed'}];revision=1;calls.length=0;beforeVersion=undefined;
  installTauriRuntimeMock(invoke as never);useConversationArchiveStore.getState().replaceArchivedConversationIds([]);
});
afterAll(()=>removeTauriRuntimeMock());
test('desktop acknowledgment captures displayed bytes and keeps a changed response unread',async()=>{
  const displayed={id:'synthetic-answer',conversation_id:c.id,task_id:'',role:'assistant' as const,content:'Observed',timestamp:c.created_at};
  beforeVersion=()=>{messages[0].content='Concurrent response';revision++;metadata[0].response_revision=revision;};
  await acknowledgeDisplayedConversation(c.id,[displayed]);expect(metadata[0].read_revision).toBe(0);expect(calls).not.toContain('db_conversation_acknowledge');
  beforeVersion=undefined;await acknowledgeDisplayedConversation(c.id,[{...displayed,content:'Concurrent response'}]);expect(metadata[0].read_revision).toBe(2);
});
test('shared refresh reflects remote rename, pin, archive and creation without selecting or hydrating transcripts',async()=>{
  useChatStore.setState({conversations:[{...mapDbConversationToConversation(c),is_unread:true}],selectedConversationId:c.id});
  conversations[0].title='Remote rename';conversations[0].is_pinned=true;metadata[0].archived=true;metadata[0].read_revision=1;
  conversations.push({...c,id:'created-chat',title:'Created remotely'});metadata.push({...metadata[0],conversation_id:'created-chat',archived:false,response_revision:0,read_revision:0});
  await useChatStore.getState().refreshConversationMetadata();
  const state=useChatStore.getState();expect(state.selectedConversationId).toBe(c.id);expect(state.conversations).toHaveLength(2);expect(state.conversations[0]).toMatchObject({title:'Remote rename',is_pinned:true,is_unread:false});expect(useConversationArchiveStore.getState().archivedConversationIds.has(c.id)).toBe(true);expect(calls).not.toContain('db_list_messages');
});
test('desktop archive writes desired state and preserves unrelated concurrent archive membership',async()=>{
  conversations.push({...c,id:'other-chat'});metadata.push({...metadata[0],conversation_id:'other-chat',archived:true});
  await persistConversationArchives([c.id],true);expect(metadata[0].archived).toBe(true);expect(metadata[1].archived).toBe(true);
  const revision=metadata[0].revision;await persistConversationArchives([c.id],true);expect(metadata[0].revision).toBe(revision);
  await persistConversationArchives([c.id],false);expect(metadata[0].archived).toBe(false);expect(metadata[1].archived).toBe(true);
});
