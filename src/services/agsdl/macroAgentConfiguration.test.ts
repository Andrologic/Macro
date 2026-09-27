import { describe, expect, it } from "bun:test";
import { createExample } from "./examples";
import { projectViewer } from "./viewer";
import { applyChanges, validateDocument } from "./document";
import { macroAgentConfiguration, macroConfigurationChanges } from "./macroAgentConfiguration";

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
