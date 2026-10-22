import { describe, expect, it } from "bun:test";
import { createLegacyExample as createExample } from "./examples";
import { projectViewer } from "./viewer";
import { applyChanges, validateDocument } from "./document";
import { macroNativeModelEdition, readMacroNativeModel } from "./nativeModelEdition";
import { macroAgentConfiguration, macroConfigurationChanges, MACRO_ENGINE_CONTRACT, MACRO_ENGINE_IMPLEMENTATION } from "./macroAgentConfiguration";

const setup = () => {
  const doc = JSON.parse(createExample("release"));
  const source = () => JSON.stringify(doc);
  const card = () => projectViewer(source()).graphs[0].cards[0];
  return { doc, source, card };
};
describe("Macro model configuration", () => {
  it("sets only the model binding and preserves opaque parameters and tool grants", () => {
    const { doc, source, card } = setup();
    const original = doc.runtime.configurations[0].agents[0];
    original.parameters = { temperature: 0.2, opaque: { future: true } };
    original.tools = [{ tool: { scope: "demo", id: "declared", version: "1" }, choices: [] }];
    const result = JSON.parse(applyChanges(source(), macroConfigurationChanges(source(), card(), "provider-a", "model-a")));
    const binding = result.runtime.configurations[0].agents[0];
    expect(binding.engine).toEqual({ identity: "macro/desktop", version: "1" });
    expect(binding.parameters).toEqual({ ...original.parameters, providerId: "provider-a", modelId: "model-a" });
    expect(binding.tools).toEqual(original.tools);
    expect(binding.applications).toEqual(original.applications);
    expect(result.runtime.selected).toBeUndefined();
    expect(result.runtime.configurations[0].agents.slice(1)).toEqual(doc.runtime.configurations[0].agents.slice(1));
  });
  it("produces a binding accepted by the AgSDL reader", async () => {
    const source = createExample("release");
    const card = projectViewer(source).graphs[0].cards[0];
    const configured = applyChanges(source, macroConfigurationChanges(source, card, "provider-a", "model-a"));
    const reports = await validateDocument(configured);
    const failures = reports.flatMap(report => report.results.filter(result => result.verdict !== "pass"));
    expect(failures).toEqual([]);
  });
  it("repairs only the identity of an earlier Macro binding", async () => {
    const { doc, source, card } = setup();
    const binding = doc.runtime.configurations[0].agents[0];
    binding.engine = { identity: "macro", version: "1" };
    binding.parameters = { providerId: "provider-a", modelId: "model-a", temperature: 0.2 };
    const changes = macroConfigurationChanges(source(), card(), "provider-a", "model-a");
    expect(macroAgentConfiguration(source(), card()).editable).toBe(true);
    expect(changes).toEqual([{ op: "set", path: "/runtime/configurations/0/agents/0/engine/identity", valueJson: '"macro/desktop"' }]);
    const repaired = JSON.parse(applyChanges(source(), changes));
    expect(repaired.runtime.configurations[0].agents[0]).toEqual({
      ...binding, engine: { ...binding.engine, identity: "macro/desktop" },
    });
    const reports = await validateDocument(JSON.stringify(repaired));
    expect(reports.flatMap(report => report.results.filter(result => result.verdict !== "pass"))).toEqual([]);
  });
  it("blocks foreign engines and unsupported Macro editions without modifying them", () => {
    const { doc, source, card } = setup();
    for (const engine of [{ identity: "foreign", version: "1" }, { identity: "macro/desktop", version: "2" }]) {
      doc.runtime.configurations[0].agents[0].engine = engine;
      expect(macroAgentConfiguration(source(), card()).editable).toBe(false);
      expect(() => macroConfigurationChanges(source(), card(), "p", "m")).toThrow();
    }
  });
  it("requires one configuration or an explicit selected configuration within the exact graph", () => {
    const { doc, source, card } = setup();
    const copy = structuredClone(doc.runtime.configurations[0]);
    copy.id = "other";
    doc.runtime.configurations.push(copy);
    expect(macroAgentConfiguration(source(), card()).editable).toBe(false);
    doc.runtime.selected = "other";
    expect(macroAgentConfiguration(source(), card()).bindingPath).toBe("/runtime/configurations/1/agents/0");
    copy.graph.version = "foreign";
    expect(macroAgentConfiguration(source(), card()).bindingPath).toBe("/runtime/configurations/0/agents/0");
    doc.runtime.configurations[0].agents.push(structuredClone(doc.runtime.configurations[0].agents[0]));
    expect(macroAgentConfiguration(source(), card()).editable).toBe(false);
  });
  it("does not write defaults or grant tools on a no-op", () => {
    const { source, card } = setup();
    expect(macroConfigurationChanges(source(), card(), "", "")).toEqual([]);
    const result = JSON.parse(applyChanges(source(), macroConfigurationChanges(source(), card(), "p", "m")));
    expect(result.runtime.configurations[0].agents[0].tools).toEqual([]);
  });
});


describe("AgSDL 0.2 Macro configuration", () => {
  const setup02 = () => {
    const requirement = { contract: { identity: "example/media", version: "1" }, parameters: { media: "video" } };
    const doc = {
      contract: "agsdl-0.2.0", id: "system",
      agents: { helper: { configuration: "project" }, reviewer: { configuration: "project" } },
      configurations: { project: { engine: "desktop", settings: { providerId: "old", modelId: "model", temperature: 0.2, opaque: { permission: "existing" } }, tools: { inspect: "tool" }, requires: [requirement], claims: [{ requirement, status: "supported", evidence: "a".repeat(64) }] } },
      bindings: { desktop: { contract: MACRO_ENGINE_CONTRACT, implementation: MACRO_ENGINE_IMPLEMENTATION, settings: { existing: true }, claims: [{ requirement, status: "unsupported" }] }, tool: { contract: { identity: "example/tool", version: "1" }, implementation: { identity: "example/local-tool", version: "1" } } },
      flow: { entry: "work", steps: { work: { type: "agent", agent: "helper" } } },
    };
    const source = () => JSON.stringify(doc);
    const card = { path: "/flow/steps/work", id: "work", kind: "agent", details: {} } as Parameters<typeof macroAgentConfiguration>[1];
    return { doc, source, card };
  };
  it("edits the native Edition and declared settings and clears stale configuration claims", async () => {
    const { doc, source, card } = setup02();
    const changes = macroConfigurationChanges(source(), card, "provider-active", "model-active");
    const edited = JSON.parse(applyChanges(source(), changes));
    expect(edited.configurations.project).toEqual({ engine: "desktop", model: macroNativeModelEdition("provider-active", "model-active"), settings: { ...doc.configurations.project.settings, providerId: "provider-active", modelId: "model-active" }, tools: doc.configurations.project.tools, requires: doc.configurations.project.requires });
    expect(edited.bindings).toEqual(doc.bindings);
    expect(edited.agents).toEqual(doc.agents);
    expect(edited.flow).toEqual(doc.flow);
    const reports = await validateDocument(JSON.stringify(edited));
    expect(reports.flatMap(report => report.results.filter(result => result.verdict !== "pass"))).toEqual([]);
    expect(reports[0].executionSupport).toBe("not-assessed");
    const report = JSON.parse(reports[0].documentReportJson as string);
    expect(report.support.find((item: { path: string }) => item.path === "/agents/helper").status).toBe("unknown");
    expect(report.support.find((item: { path: string }) => item.path === "/agents/reviewer").status).toBe("unknown");
  });
  it("keeps exact claims on a no-op and handles graphless Agent cards", () => {
    const { doc, source, card } = setup02();
    doc.configurations.project = { ...doc.configurations.project, model: macroNativeModelEdition("old", "model") } as typeof doc.configurations.project;
    expect(macroConfigurationChanges(source(), card, "old", "model")).toEqual([]);
    expect(macroAgentConfiguration(source(), { ...card, path: "/agents/helper", kind: "Agent" })).toEqual({ editable: true, providerId: "old", modelId: "model", bindingPath: "/configurations/project" });
  });
  it("completes an explicit same-pair choice instead of treating a missing Edition as a no-op", () => {
    const { doc, source, card } = setup02();
    const changes = macroConfigurationChanges(source(), card, "old", "model");
    const edited = JSON.parse(applyChanges(source(), changes));
    expect(edited.configurations.project.model).toEqual(macroNativeModelEdition("old", "model"));
    expect(edited.configurations.project.settings).toEqual(doc.configurations.project.settings);
    expect(edited.configurations.project.claims).toBeUndefined();
  });
  it("edits an existing native Edition and fills only absent matching settings", () => {
    const { doc, card } = setup02();
    const input = { ...doc, configurations: { project: { ...doc.configurations.project, model: macroNativeModelEdition("fournisseur/été", "modèle:α/β"), settings: { opaque: { preserve: true } } } } };
    const source = JSON.stringify(input);
    expect(macroAgentConfiguration(source, card)).toMatchObject({ editable: true, providerId: "fournisseur/été", modelId: "modèle:α/β" });
    const same = JSON.parse(applyChanges(source, macroConfigurationChanges(source, card, "fournisseur/été", "modèle:α/β")));
    expect(same.configurations.project.settings).toEqual({ opaque: { preserve: true }, providerId: "fournisseur/été", modelId: "modèle:α/β" });
    const changed = JSON.parse(applyChanges(source, macroConfigurationChanges(source, card, "new/provider", "new/model")));
    expect(changed.configurations.project.model).toEqual(macroNativeModelEdition("new/provider", "new/model"));
    expect(changed.configurations.project.settings).toEqual({ opaque: { preserve: true }, providerId: "new/provider", modelId: "new/model" });
    expect(changed.bindings).toEqual(input.bindings);
  });
  it("retains exact UTF-8 identities, including a leading BOM, and refuses invalid strings", () => {
    const pair = { providerId: "\uFEFFprovider/é", modelId: "モデル/🧪" };
    expect(readMacroNativeModel(macroNativeModelEdition(pair.providerId, pair.modelId), undefined)).toEqual(pair);
    expect(() => macroNativeModelEdition("provider", "\uD800")).toThrow();
  });
  it("refuses contradictory settings and malformed or foreign Editions without mutating the source", () => {
    const { doc, card } = setup02();
    const edition = macroNativeModelEdition("old", "model");
    for (const model of [
      { ...edition, version: "2" }, { ...edition, extra: true },
      { ...edition, identity: edition.identity + "=" },
      { identity: "macro/native-model/p/_w/m/bW9kZWw", version: "1" },
      { identity: "macro/native-model/p/b2xk/m/bW9kZWx", version: "1" },
      macroNativeModelEdition("other", "model"),
    ]) {
      const source = JSON.stringify({ ...doc, configurations: { project: { ...doc.configurations.project, model } } });
      expect(macroAgentConfiguration(source, card).editable).toBe(false);
      expect(() => macroConfigurationChanges(source, card, "p", "m")).toThrow();
      expect(JSON.parse(source).configurations.project.model).toEqual(model);
    }
  });
  it("does not round-trip opaque numbers during a model change", () => {
    const { source, card } = setup02();
    const raw = source().replace('"temperature":0.2', '"temperature":12345678901234567890.123456789');
    expect(applyChanges(raw, macroConfigurationChanges(raw, card, "p", "m"))).toContain('"temperature":12345678901234567890.123456789');
  });
  it("blocks foreign declarations, dynamic choices and explicit Model editions", () => {
    const { doc, source, card } = setup02();
    const blocked = (value: unknown) => expect(macroAgentConfiguration(JSON.stringify(value), card).editable).toBe(false);
    blocked({ ...doc, bindings: { ...doc.bindings, desktop: { ...doc.bindings.desktop, contract: { identity: "foreign/engine", version: "1" } } } });
    blocked({ ...doc, bindings: { ...doc.bindings, desktop: { ...doc.bindings.desktop, implementation: { identity: "macro/desktop", version: "2" } } } });
    blocked({ ...doc, agents: { helper: { configuration: { select: { path: [] }, cases: { first: "project" } } } } });
    blocked({ ...doc, configurations: { project: { ...doc.configurations.project, model: { identity: "example/model", version: "1" } } } });
    blocked({ ...doc, configurations: { project: { ...doc.configurations.project, engine: "missing" } } });
    blocked({ ...doc, contract: "agsdl-exp-flow-0.2-c1" });
    expect(macroConfigurationChanges(source(), card, "p", "m").every(change => !change.path.startsWith("/bindings"))).toBe(true);
  });
});
