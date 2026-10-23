import { describe, expect, it, mock } from "bun:test";
import type { ChatMessage, SkillManifest } from "../types";
import type { ArchitectPlanRecord } from "./architectPlanService";
import { prepareChatMessages, type ChatMessagePreparationInput, type ChatMessagePreparationPorts } from "./chatMessagePreparation";

const fixture = () => {
  const user: ChatMessage = { id: "user", conversation_id: "conversation", task_id: "", role: "user", content: "Inspect the attachment", timestamp: "2026-01-01T00:00:00Z", context_refs: [] };
  const messages = [user];
  const context = { groupId: null, groupName: null, projectIds: [], actionableProjectIds: [], contextProjectIds: [], projectMounts: [], focusedProjectId: null, virtualRootEnabled: false, workspacePathsByProjectId: {}, defaultWorkspacePath: null, projectId: null, projectName: null, taskId: null, branchName: null, workspacePath: null };
  const snapshot = { conversationId: "conversation", turnId: "user", capturedAt: user.timestamp, skills: {} };
  const skills: ReturnType<ChatMessagePreparationPorts["skills"]> = {
    prepareSkillsForTurn: mock(async () => ({ activatedSkills: [], systemInstructionBlocks: [], explicitSkillIds: [], warnings: [], toolsAvailable: true, permissionSnapshot: snapshot })),
    getSkillById: (_id: string): SkillManifest | null => null,
    getEnabledLoadableSkills: (): SkillManifest[] => [],
  };
  const app: ReturnType<ChatMessagePreparationPorts["app"]> = { mode: "Chat", agentType: "build", selectedTaskId: null, activePlanContext: null, planNodes: [], getProjectById: () => undefined };
  const ports: ChatMessagePreparationPorts = {
    app: () => app, skills: () => skills, executionContext: () => context,
    loadRiskLevel: async () => "balanced",
    repositoryInstructions: async () => ({ contextBlock: null, sources: [], issues: [], totalBytes: 0 }),
    contextCitations: () => [], sourceCitations: () => [], orderedMessages: () => messages,
    composerContextRefs: () => { throw new Error("A saved turn must own its context refs"); },
    messageImages: () => ({}), loadModePrompt: async () => "Local mode prompt",
    internalAgentProfilePromptKey: () => null, loadPrompt: async () => { throw new Error("No profile prompt"); },
    conversationTaskId: () => null, task: () => undefined, previousAssistantContext: () => null,
    standaloneTaskInstruction: () => { throw new Error("No standalone task"); },
    taskArtifactContext: async () => { throw new Error("No task artifacts"); },
    architectPlanInstructions: async () => { throw new Error("No Architect context"); },
  };
  const input: ChatMessagePreparationInput = { conversationId: "conversation", allowedToolIds: [], skillPermissionSnapshot: snapshot };
  return { input, ports, user, messages, skills, snapshot, context, app, run: () => prepareChatMessages(input, ports) };
};

describe("shared chat message preparation", () => {
  it("bundles the real core and secret forms for Bun without desktop, UI, IPC or transport imports", async () => {
    const build = await Bun.build({
      entrypoints: [import.meta.dir + "/chatMessagePreparation.ts", import.meta.dir + "/macroPilot/secretForms.ts"],
      target: "bun",
      plugins: [{ name: "closed-preparation-imports", setup(builder) {
        builder.onResolve({ filter: /(?:stores\/|components\/|@tauri|react|zustand|streamingChat|serviceRuntime|nativeClient|transport)/ }, args => {
          throw new Error(`Unexpected runtime import: ${args.path}`);
        });
      } }],
    });
    expect(build.logs).toEqual([]);
    expect(build.success).toBe(true);
  });

  it("prepares images, citations, skills and separate persistable provider items with the real body", async () => {
    const f = fixture();
    const skill: SkillManifest = { id: "skill", name: "inspect", description: "Inspect attachments", source: { kind: "global", rootPath: "skills" }, resources: [], scripts: [], validationErrors: [], isValid: true };
    f.user.context_refs = [{ id: "file", kind: "file", title: "Attached", path: "src/example.ts" }, { id: skill.id, kind: "skill", title: skill.name }];
    const opaque = { type: "function_call_output", call_id: "call", output: "saved result" };
    f.user.provider_input_items = [opaque, { type: "message", role: "user", content: [{ type: "input_text", text: "Saved user text" }] }];
    const original = structuredClone(f.user);
    f.input.allowedToolIds = ["read_file", "mark_source_passage", "skill_activate"];
    f.input.messageWithImagesId = f.user.id;
    f.ports.messageImages = () => ({ user: [{ id: "image", dataUrl: "data:image/png;base64,AQID", mimeType: "image/png", width: 3, height: 2, createdAt: f.user.timestamp }] });
    f.ports.repositoryInstructions = async () => ({ contextBlock: "Scoped repository instructions", sources: [], issues: [], totalBytes: 30 });
    const citation = { id: "context", type: "file" as const, scope: "context" as const, source: "src/context.ts", title: "Context", snippet: "x".repeat(4001), messageId: "user", conversationId: "conversation", timestamp: f.user.timestamp };
    const source = { ...citation, id: "source", type: "source_passage" as const, scope: "source" as const, title: "Important", source: "Saved source", snippet: "Do not inject this source body" };
    f.ports.contextCitations = () => [citation];
    f.ports.sourceCitations = () => [source];
    f.skills.getSkillById = () => skill;
    f.skills.getEnabledLoadableSkills = () => [skill];
    f.skills.prepareSkillsForTurn = mock(async () => ({ activatedSkills: [{ skillId: skill.id, body: "Skill body", activatedAt: f.user.timestamp }], systemInstructionBlocks: ["Skill body"], explicitSkillIds: [skill.id], warnings: ["Refresh the skill", "Skill no longer available in settings"], toolsAvailable: true, permissionSnapshot: f.snapshot }));
    const result = await f.run();
    const prepared = result.preparedMessages[0]!;
    expect(prepared.content).toEqual([{ type: "text", text: expect.stringContaining("Scoped repository instructions") }, { type: "image_url", image_url: { url: "data:image/png;base64,AQID" } }]);
    const text = (prepared.content as Array<{ text?: string }>)[0]!.text!;
    expect(text).toContain("x".repeat(4000) + "…");
    expect(text).toContain("citation_id=source");
    expect(text).not.toContain(source.snippet);
    expect(text).toContain("File path: src/example.ts");
    expect(text).toContain("already loaded this explicit skill");
    expect(prepared.image_metadata?.[0]).toMatchObject({ width: 3, height: 2, mimeType: "image/png", sourceFingerprint: expect.any(String) });
    expect(result.providerInputItemsByMessageId.user?.[0]).toEqual(opaque);
    expect(JSON.stringify(result.providerInputItemsByMessageId.user)).toContain("Scoped repository instructions");
    expect(JSON.stringify(result.persistableProviderInputItemsByMessageId.user)).not.toContain("Scoped repository instructions");
    expect(JSON.stringify(result.persistableProviderInputItemsByMessageId.user)).toContain("REFERENCED ITEMS");
    expect(result.systemMessage).toContain("Skill body");
    expect(result.systemMessage).toContain("Available files: Context, src/example.ts");
    expect(result.systemMessage).toContain("name=inspect");
    expect(result.skillTurnFeedback).toEqual({ messageId: "user", loaded: [{ skillId: "skill", title: "inspect", status: "loaded" }], warnings: [{ title: "Skill context", status: "blocked", reason: "Refresh the skill", action: "refresh" }, { title: "Skill context", status: "ignored", reason: "Skill no longer available in settings", action: "open_settings" }] });
    expect(result.skillPermissionSnapshot).toBe(f.snapshot);
    expect(f.skills.prepareSkillsForTurn).toHaveBeenCalledWith({ conversationId: "conversation", content: f.user.content, contextRefs: f.user.context_refs, toolsAvailable: true, permissionSnapshot: f.snapshot });
    expect(f.user).toEqual(original);
  });

  it("preserves saved provider items and turn state while sanitizing assistant context", async () => {
    const f = fixture();
    const assistant: ChatMessage = { ...f.user, id: "assistant", role: "assistant", content: "<think>hidden</think>\n[TOOL] read\nVisible answer", provider_input_items: [{ type: "reasoning", summary: "saved" }], provider_turn_state: { provider: "chatgpt", response_id: "synthetic-response", output_items: [] } };
    f.messages.unshift(assistant);
    f.user.provider_input_items = [{ type: "message", role: "user", content: "Original provider content" }];
    f.ports.sourceCitations = () => { throw new Error("source citation read failure"); };
    await expect(f.run()).rejects.toThrow("source citation read failure");
    f.ports.sourceCitations = () => [];
    const result = await f.run();
    expect(result.preparedMessages[0]).toMatchObject({ content: "Visible answer", provider_turn_state: assistant.provider_turn_state, provider_input_items: assistant.provider_input_items });
    expect(result.preparedMessages[1]!.provider_input_items).toEqual(f.user.provider_input_items);
    expect(result.preparedMessages[1]!.provider_input_items).not.toBe(f.user.provider_input_items);
    expect(result.orderedMessages).toBe(f.messages);
  });

  it("uses the captured plan and context after an asynchronous read and preserves explicit null", async () => {
    const f = fixture();
    const plan: ArchitectPlanRecord = { id: "captured", slug: "captured", title: "Captured plan", description: "Captured", status: "draft", targetBranch: "plan/captured", createdAt: f.user.timestamp, updatedAt: f.user.timestamp, nodes: [], predictedBranches: [] };
    f.input.modeAtSend = "Architect";
    f.input.architectPlanOverride = plan;
    f.input.executionContextOverride = f.context;
    f.input.riskLevelOverride = "strict";
    f.ports.executionContext = () => { throw new Error("The context was captured"); };
    f.ports.loadRiskLevel = async () => { throw new Error("The risk was captured"); };
    f.ports.repositoryInstructions = async () => {
      await Promise.resolve();
      f.app.activePlanContext = { ...plan, id: "different" };
      return { contextBlock: null, sources: [], issues: [], totalBytes: 0 };
    };
    const prompt = mock(async (..._args: Parameters<ChatMessagePreparationPorts["architectPlanInstructions"]>) => ["Captured plan instructions"]);
    f.ports.architectPlanInstructions = prompt;
    expect((await f.run()).systemMessage).toContain("Captured plan instructions");
    expect(prompt.mock.calls[0]?.slice(0, 3)).toEqual([plan, plan.nodes, f.context]);
    f.input.architectPlanOverride = null;
    await f.run();
    expect(prompt.mock.calls[1]?.slice(0, 3)).toEqual([null, [], f.context]);
    f.ports.repositoryInstructions = async () => { throw new Error("Repository instructions unavailable"); };
    await expect(f.run()).rejects.toThrow("Repository instructions unavailable");
  });
});
