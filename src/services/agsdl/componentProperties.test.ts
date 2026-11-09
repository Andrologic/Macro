import { describe, expect, it } from "bun:test";
import { componentProperties, propertyChanges } from "./componentProperties";
import { applyChanges } from "./document";
import { createLegacyExample } from "./examples";
import { projectViewer } from "./viewer";

const setup = () => {
  const doc = JSON.parse(createLegacyExample("release"));
  return { doc, first: doc.graphs[0].steps[0] };
};
describe("essential component properties", () => {
  it("changes a resource reference without rewriting bindings or opaque source", () => {
    const { doc, first } = setup();
    const resource = structuredClone(doc.definitions.find((value: { kind: string }) => value.kind === "Resource"));
    resource.key.version = "2"; doc.definitions.push(resource);
    const source = JSON.stringify(doc).replace('"extensions":[]', '"extensions":[{"opaque":900719925474099312345}]');
    const card = projectViewer(source).graphs[0].cards[0];
    const properties = componentProperties(source, card);
    const field = properties.fields.find(field => field.path.endsWith("/resources/0"))!;
    const values = properties.fields.map(field => field.value);
    values[properties.fields.indexOf(field)] = field.options!.find(option => option.value && JSON.parse(option.value).version === "2")!.value;
    const edited = applyChanges(source, propertyChanges(properties.fields, values));
    expect(edited).toContain("900719925474099312345");
    expect(JSON.parse(edited).graphs[0].steps[0].bindings).toEqual(first.bindings);
    expect(JSON.parse(edited).graphs[0].steps[0].resources[0].version).toBe("2");
  });
  it("offers only exposed interfaces with the same operation, action and contracts", () => {
    const { doc, first } = setup();
    const original = doc.definitions.find((value: { key: unknown }) => JSON.stringify(value.key) === JSON.stringify(first.interface));
    const compatible = structuredClone(original); compatible.key.id = "compatible";
    const incompatible = structuredClone(original); incompatible.key.id = "incompatible"; incompatible.payload.operations[0].outputs = { other: "json" };
    doc.definitions.push(compatible, incompatible);
    for (const definition of [compatible, incompatible]) doc.relations.push({ source: first.agent, relation: "exposes", target: definition.key, expectedKind: "Interface" });
    const source = JSON.stringify(doc);
    const fields = componentProperties(source, projectViewer(source).graphs[0].cards[0]).fields;
    const field = fields.find(field => field.path.endsWith("/interface"))!;
    expect(field.options!.map(option => JSON.parse(option.value).id)).toEqual([first.interface.id, "compatible"]);
    expect(fields.filter(field => /\/(inputs|outputs)\//.test(field.path)).every(field => field.readonly)).toBe(true);
    const declaration = projectViewer(source).declarations.find(card => card.id === first.interface.id)!;
    expect(componentProperties(source, declaration).fields.filter(field => /\/outputs\//.test(field.path)).every(field => field.readonly)).toBe(true);
  });
  it("adds a tool at the agent relation owner and leaves unrelated relation metadata intact", () => {
    const { doc, first } = setup();
    const tool = { key: { scope: "example", id: "tool", version: "1" }, kind: "Tool", owner: doc.root.key, payload: {} };
    doc.definitions.push(tool);
    const source = JSON.stringify(doc);
    const fields = componentProperties(source, projectViewer(source).graphs[0].cards[0]).fields;
    const values = fields.map(field => field.relationSource ? field.options![1].value : field.value);
    const edited = JSON.parse(applyChanges(source, propertyChanges(fields, values)));
    expect(edited.relations.slice(0, -1)).toEqual(doc.relations);
    expect(edited.relations.at(-1)).toEqual({ source: first.agent, relation: "uses", target: tool.key, expectedKind: "Tool" });
  });
});

it("removes references in descending order while preserving untouched relations", () => {
  const { doc, first } = setup();
  const resource = structuredClone(doc.definitions.find((value: { kind: string }) => value.kind === "Resource"));
  resource.key.id = "other-resource"; doc.definitions.push(resource);
  first.resources.push(resource.key);
  const source = JSON.stringify(doc);
  const fields = componentProperties(source, projectViewer(source).graphs[0].cards[0]).fields;
  expect(() => propertyChanges(fields, fields.map(field => field.removePath ? "" : field.value))).toThrow("resourceRequired");
  const edited = JSON.parse(applyChanges(source, propertyChanges(fields, fields.map(field => field.path.endsWith("/resources/1") ? "" : field.value))));
  expect(edited.graphs[0].steps[0].resources).toHaveLength(1);
  expect(edited.relations).toEqual(doc.relations);
});

it("edits only simple unused operation contracts and protects configured tool bindings", () => {
  const { doc, first } = setup();
  const unused = structuredClone(doc.definitions.find((value: { kind: string }) => value.kind === "Interface"));
  unused.key.id = "unused-interface"; doc.definitions.push(unused);
  const tool = { key: { scope: "synthetic", id: "bound-tool", version: "1" }, kind: "Tool", owner: doc.root.key, payload: { inputs: { query: "string" }, outputs: { answer: "json" } } };
  doc.definitions.push(tool);
  doc.relations.push({ source: first.agent, relation: "uses", target: tool.key, expectedKind: "Tool" });
  doc.runtime.configurations[0].agents[0].tools = [{ tool: tool.key }];
  const source = JSON.stringify(doc);
  const view = projectViewer(source);
  const properties = componentProperties(source, view.declarations.find(card => card.id === unused.key.id)!);
  const field = properties.fields.find(field => field.path.endsWith("/inputs/brief"))!;
  expect(field.readonly).toBe(false);
  expect(field.options!.map(option => option.value)).toEqual(["string", "boolean", "json"]);
  const edited = JSON.parse(applyChanges(source, propertyChanges(properties.fields, properties.fields.map(item => item === field ? "json" : item.value))));
  expect(edited.graphs).toEqual(doc.graphs);
  expect(edited.definitions.at(-2).payload.operations[0].inputs.brief).toBe("json");
  const agentFields = componentProperties(source, view.graphs[0].cards[0]).fields;
  expect(agentFields.find(field => field.label === "tools")!.readonly).toBe(true);
  expect(agentFields.some(field => field.relationSource)).toBe(false);
  const toolFields = componentProperties(source, view.declarations.find(card => card.id === tool.key.id)!).fields;
  expect(toolFields.every(field => field.readonly)).toBe(true);
});

it("keeps incomplete documents editable without manufacturing references", () => {
  const { doc, first } = setup();
  first.resources = [];
  doc.relations.push({ source: first.agent, relation: "uses", expectedKind: "Tool" });
  const source = JSON.stringify(doc);
  const properties = componentProperties(source, projectViewer(source).graphs[0].cards[0]);
  expect(properties.unsupported).toBe(true);
  expect(propertyChanges(properties.fields, properties.fields.map(field => field.value))).toEqual([]);
});

it("rejects duplicate references selected within the same atomic draft", () => {
  const { doc, first } = setup();
  const original = doc.definitions.find((value: { kind: string }) => value.kind === "Resource");
  const second = structuredClone(original); second.key.id = "second";
  const third = structuredClone(original); third.key.id = "third";
  doc.definitions.push(second, third); first.resources.push(second.key);
  const source = JSON.stringify(doc);
  const fields = componentProperties(source, projectViewer(source).graphs[0].cards[0]).fields;
  const values = fields.map(field => field.removePath?.includes("/resources/") ? field.options!.find(option => option.value && JSON.parse(option.value).id === "third")!.value : field.value);
  expect(() => propertyChanges(fields, values)).toThrow("duplicateReference");
});

it("rejects a mixed agent reassignment and captured-definition edit at the patch boundary", () => {
 const source = '{"contract":"agsdl-0.3.0","id":"owners","agents":{"a":{"harness":"codex","permissions":"read-only","instructions":"A"},"b":{"harness":"codex","permissions":"read-only","instructions":"B"}},"flow":{"entry":"one","steps":{"one":{"type":"agent","agent":"a"},"other":{"type":"agent","agent":"a"}}}}';
 const fields = componentProperties(source, projectViewer(source).graphs[0].cards[0]).fields;
 const values = fields.map(field => field.path === "/flow/steps/one/agent" ? '"b"' : field.path === "/agents/a/instructions" ? '"Wrong owner"' : field.value);
 expect(() => propertyChanges(fields, values)).toThrow("authoring030.ownerChangeHint");
});
for (const type of ["agent", "call", "approval", "compose", "join"]) {
 it(`marks a ${type} body step as shared when its composition has two uses`, () => {
  const source = JSON.stringify({ contract: "agsdl-0.3.0", id: "shared", agents: { a: { harness: "codex", permissions: "read-only" } },
   flow: { entry: "first", steps: { first: { type: "compose", composition: "common", next: { done: "second" } }, second: { type: "compose", composition: "common", next: { done: [] } } } },
   compositions: { common: { entry: "work", steps: { work: { type, ...(type === "agent" ? { agent: "a" } : type === "call" ? { command: "echo" } : type === "compose" ? { composition: "leaf" } : {}), next: { done: { output: "done" } } } }, outputs: ["done"] } },
  });
  const card = projectViewer(source).graphs.find(graph => graph.path === "/compositions/common")!.cards[0];
  const properties = componentProperties(source, card);
  expect(properties.shared).toBe(true);
  expect(properties.fields.some(field => field.path === "/compositions/common/steps/work/type")).toBe(true);
 });
}
