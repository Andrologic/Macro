import { cpus, platform, release, arch, totalmem } from "node:os";
import assert from "node:assert/strict";
import type { ChatMessage, ConversationRuntimeState, ProviderTurnState, ToolTrace } from "../../src/types";
import { EMPTY_CONVERSATION_RUNTIME } from "../../src/domains/chat/runtimeState";
import { createAssistantStreamRuntime, type ChatAssistantStreamPorts } from "../../src/services/chatAssistantStreamRuntime";
import { createChatTurnRuntime } from "../../src/services/chatTurnRuntime";
import type { AssistantStreamLaunch } from "../../src/services/chatStreamContracts";
import { distribution } from "./stats";
import { assertCleanBuildSource } from "./build-provenance";

const root = new URL("../../", import.meta.url);
const warmup = 10;
const observations = 100;
const sizes = [100, 1_000, 10_000] as const;
const content = "synthetic message ".padEnd(256, "x");
const timestamp = "2026-01-01T00:00:00.000Z";
const stop = Symbol("diagnostics-record-stop");

type Scenario = "simple" | "nested";
type Measurement = { orderedToRecord: number; startToRecord: number };
type NestedProviderItem = {
  type: string;
  call_id: string;
  output: { content: Array<{ type: string; text: string }>; metadata: { index: number } };
};

function throwSentinel(): never {
  throw new Error("Unreachable synthetic port");
}

function nestedFields(index: number): Pick<ChatMessage, "tool_traces" | "provider_input_items" | "provider_turn_state"> {
  const toolTrace: ToolTrace = {
    tool_call_id: `call-${index}`,
    tool_name: "terminal_run",
    status: "done",
    detail: `result-${index}`,
  };
  const providerTurnState: ProviderTurnState = {
    provider: "chatgpt",
    response_id: `response-${index}`,
    output_items: [{ type: "message", content: [{ type: "text", text: `state-${index}` }] }],
  };
  return {
    tool_traces: [toolTrace],
    provider_input_items: [{
      type: "function_call_output",
      call_id: `call-${index}`,
      output: { content: [{ type: "text", text: `provider-${index}` }], metadata: { index } },
    }],
    provider_turn_state: providerTurnState,
  };
}

function fixtureMessages(count: number, scenario: Scenario): ChatMessage[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `message-${String(index).padStart(6, "0")}`,
    task_id: "fixture-task",
    conversation_id: "fixture-conversation",
    role: index % 2 ? "assistant" : "user",
    content,
    timestamp,
    ...(scenario === "nested" ? nestedFields(index) : {}),
  }));
}

function launch(): AssistantStreamLaunch {
  return {
    sessionId: "diagnostics-session",
    conversationId: "fixture-conversation",
    assistantMessage: {
      id: "assistant-message",
      turn_id: "diagnostics-turn",
      task_id: "fixture-task",
      conversation_id: "fixture-conversation",
      role: "assistant",
      content: "",
      timestamp,
    },
    replyToMessageId: "message-000000",
    userContent: "synthetic request",
    modeAtSend: "Architect",
    resolvedTaskId: "fixture-task",
    selectedProviderId: "provider",
    selectedModelId: "model",
    providerConfig: {
      id: "provider", name: "Synthetic provider", providerType: "openai",
      baseUrl: "https://provider.invalid", hasStoredApiKey: false, isEnabled: true,
      isLocal: false,
    },
    messagesForRequest: [{ role: "user", content: "synthetic request" }],
    contextDiagnosticsBaselineSeed: {
      conversationId: "fixture-conversation", modeAtSend: "Architect", providerId: "provider",
      providerType: "openai", baseUrl: "https://provider.invalid", modelId: "model",
      modelContextWindowTokens: 128_000, allowedToolIds: ["read"], toolDefinitions: [],
      messagesForRequest: [], citations: [], repositoryInstructionSources: [], repositoryInstructionIssues: [],
    },
    executionContext: {
      groupId: null, groupName: null, projectIds: ["fixture-project"], actionableProjectIds: ["fixture-project"],
      contextProjectIds: [], projectMounts: [], focusedProjectId: "fixture-project", virtualRootEnabled: false,
      workspacePathsByProjectId: { "fixture-project": "/synthetic/fixture-project" },
      defaultWorkspacePath: "/synthetic/fixture-project", projectId: "fixture-project", projectName: "fixture-project",
      taskId: "fixture-task", branchName: "develop", workspacePath: "/synthetic/fixture-project",
    },
    fileToolContext: [], allowedToolIds: ["read"], riskLevel: "balanced", scopedTurnConfiguration: null,
    showToolTraces: true, enableWebSearch: false, enableWebFetch: false, webSearchOptions: undefined,
    mcpTools: [], mcpServers: [], skillToolIds: [], runnableSkillToolIds: [], maxTurns: 10,
    abortController: new AbortController(),
  };
}

function measure(messagesInput: ChatMessage[], scenario: Scenario): Measurement {
  const states = new Map<string, ConversationRuntimeState>();
  const input = launch();
  const messages = [...messagesInput, input.assistantMessage];
  let orderedAt = 0;
  let recordAt = 0;
  let captured: unknown;
  const owner = createChatTurnRuntime({
    state: {
      read: (id) => states.get(id) ?? EMPTY_CONVERSATION_RUNTIME,
      project: (id, state) => { if (state) states.set(id, state); else states.delete(id); },
      isDeleted: () => false,
    },
    cancelTransport: throwSentinel,
    settled: throwSentinel,
  });
  const impossibleAdapters: ChatAssistantStreamPorts["persistence"]["adapters"] = {
    isTauriAvailable: () => true,
    ipc: {
      getChatBootstrapSnapshot: throwSentinel, listConversations: throwSentinel, listMessages: throwSentinel,
      createMessage: throwSentinel, updateMessage: throwSentinel, renameConversation: throwSentinel,
      deleteConversation: throwSentinel, deleteConversations: throwSentinel, deleteConversationTurn: throwSentinel,
      deleteMessagesAfter: throwSentinel,
    },
  };
  const ports: ChatAssistantStreamPorts = {
    owner,
    isDeleted: () => false,
    messages: {
      get: (id) => messages.find((message) => message.id === id && message.conversation_id === "fixture-conversation"),
      ordered: () => {
        orderedAt = performance.now();
        return messages;
      },
      append: throwSentinel, fields: throwSentinel, content: throwSentinel,
      completed: throwSentinel, removeEmpty: throwSentinel,
    },
    persistence: {
      adapters: impossibleAdapters, complete: throwSentinel, partial: throwSentinel,
      failed: throwSentinel, sync: throwSentinel,
    },
    tasks: { status: throwSentinel, failed: throwSentinel, awaitingResponse: throwSentinel },
    provider: { reachable: throwSentinel, recordOverflowLimit: throwSentinel, copilotTimeout: throwSentinel },
    diagnostics: {
      record: (params) => {
        recordAt = performance.now();
        captured = params;
        throw stop;
      },
      clear: throwSentinel,
      refresh: throwSentinel,
    },
    prepare: throwSentinel,
    compaction: {
      status: () => undefined, setStatus: throwSentinel, create: throwSentinel,
    },
    tools: { execute: throwSentinel, preserve: throwSentinel, boundError: throwSentinel },
    replay: { finalize: throwSentinel },
    transport: throwSentinel,
  };
  const runtime = createAssistantStreamRuntime(ports);
  owner.rememberSession(input.conversationId, input.sessionId);
  owner.set(input.conversationId, {
    phase: "preparing", sessionId: input.sessionId, turnId: input.assistantMessage.turn_id,
    assistantMessageId: input.assistantMessage.id, abortController: input.abortController!, lastError: null,
  });
  const startAt = performance.now();
  try {
    runtime.start(input);
    throw new Error("Expected the synchronous diagnostic sentinel");
  } catch (error) {
    assert.equal(error, stop);
  }
  assert.ok(captured && orderedAt > 0 && recordAt >= orderedAt);
  assert.equal(messagesInput.length + 1, messages.length);
  assert.equal(messagesInput[0]?.content, content);
  const capturedMessage = (captured as Parameters<ChatAssistantStreamPorts["diagnostics"]["record"]>[0]).baseline?.orderedMessages[0];
  assert.ok(capturedMessage);
  assert.equal((captured as Parameters<ChatAssistantStreamPorts["diagnostics"]["record"]>[0]).baseline?.orderedMessages.length, messages.length);
  assert.notEqual(capturedMessage, messagesInput[0]);
  messagesInput[0]!.content = "mutated source content";
  assert.equal(capturedMessage.content, content);
  if (scenario === "nested") {
    messagesInput[0]!.tool_traces![0]!.detail = "mutated tool detail";
    const providerItem = messagesInput[0]!.provider_input_items![0] as NestedProviderItem;
    providerItem.output.content[0]!.text = "mutated provider text";
    messagesInput[0]!.provider_turn_state!.output_items[0] = { mutated: true };
    assert.equal(capturedMessage.tool_traces?.[0]?.detail, "result-0");
    assert.equal((capturedMessage.provider_input_items![0] as NestedProviderItem).output.content[0]!.text, "provider-0");
    assert.deepEqual(capturedMessage.provider_turn_state?.output_items[0], { type: "message", content: [{ type: "text", text: "state-0" }] });
  }
  return { orderedToRecord: recordAt - orderedAt, startToRecord: recordAt - startAt };
}

export function runScenario(size: number, scenario: Scenario, samplesCount = observations, warmupCount = warmup) {
  assert.ok(Number.isInteger(size) && size >= 2);
  assert.ok(Number.isInteger(samplesCount) && samplesCount > 0);
  assert.ok(Number.isInteger(warmupCount) && warmupCount >= 0);
  const samples: Measurement[] = [];
  for (let index = 0; index < warmupCount + samplesCount; index += 1) {
    const fixture = fixtureMessages(size - 1, scenario);
    const sample = measure(fixture, scenario);
    if (index >= warmupCount) samples.push(sample);
  }
  return {
    size, scenario, totalMessages: size, historyMessages: size - 1,
    orderedToRecord: distribution(samples.map((sample) => sample.orderedToRecord)),
    startToRecord: distribution(samples.map((sample) => sample.startToRecord)),
    fixture: scenario === "simple"
      ? { contentBytes: new TextEncoder().encode(content).byteLength, fields: ["id", "task_id", "conversation_id", "role", "content", "timestamp"] }
      : { contentBytes: new TextEncoder().encode(content).byteLength, fields: ["tool_traces", "provider_input_items", "provider_turn_state"], nested: true },
  };
}

if (import.meta.main) {
  const shaBefore = assertCleanBuildSource(root);
  const rows = sizes.flatMap((size) => (["simple", "nested"] as const).map((scenario) => runScenario(size, scenario)));
  const environment = {
    timestamp: new Date().toISOString(), bun: Bun.version, platform: platform(), release: release(), arch: arch(),
    cpu: cpus()[0]?.model, cpuCount: cpus().length, memoryGiB: totalmem() / 2 ** 30,
    shaBefore, shaAfter: assertCleanBuildSource(root),
    dirty: false,
  };
  assert.equal(environment.shaAfter, shaBefore, "Source changed during measurement");
  console.log(JSON.stringify({
    schema: 1,
    kind: "chat-diagnostics-ordered-messages",
    provenance: environment,
    protocol: { warmup, samples: observations, percentile: "nearest-rank", sequential: true, stop: "first diagnostics.record before transport" },
    timing: { unit: "ms", orderedToRecord: "ordered() returns the already ordered fixture; the runtime structuredClone is timed", startToRecord: "runtime.start through the first diagnostics.record, including authority snapshots" },
    rows,
    unavailable: ["provider transport", "native IO", "IPC", "browser/Tauri runtime"],
  }, null, 2));

}
