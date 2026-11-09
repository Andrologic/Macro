import { expect, it } from "bun:test";
import { authoringFields030, authoringValues030, patchAuthoringValue030, updateAuthoringField030 } from "./authoringFields030";
import { componentProperties, propertyChanges } from "./componentProperties";
import { applyChanges } from "./document";
import { projectViewer030 } from "./viewer030";

const source = '{"contract":"agsdl-0.3.0","id":"forms","opaque":9007199254740993,"agents":{"worker":{"harness":"codex","permissions":"read-only","instructions":[{"value":"Standing orders","future":123456789012345678901234567890}],"resources":{"brief":{"value":"Background","unknown":9007199254740993}}}},"flow":{"entry":"write","steps":{"write":{"type":"agent","agent":"worker","prompt":"One mission","next":{"approve":{"step":"vote","each":["results","items"],"concurrency":9007199254740993,"message":{"prompt":"Review","resources":{"notes":{"value":"Read only"}}},"unknown":9007199254740993},"finish":[]}},"vote":{"type":"join","quorum":{"count":9007199254740993,"accept":["yes"],"unknown":9007199254740993},"remaining":"finish"}}}}';
function properties(path: string) {
  const view = projectViewer030(source);
  const card = [...view.declarations, ...view.graphs.flatMap(graph => graph.cards)].find(card => card.path === path)!;
  return componentProperties(source, card);
}
function change(path: string, label: string, value: string, name?: string) {
  const { fields } = properties(path);
  const values = fields.map(field => field.value);
  const field = authoringFields030(fields).find(field => field.label === label && (!name || field.name === name))!;
  return { fields, values: updateAuthoringField030(values, field, value), field };
}
it("separates standing instructions, a work mission and information at their actual owners", () => {
  const properties = change("/flow/steps/write", "instructions", "New standing orders");
  const changes = propertyChanges(properties.fields, properties.values);
  expect(changes.map(change => change.path)).toEqual(["/agents/worker/instructions"]);
  const result = applyChanges(source, changes);
  expect(result).toContain('"value":"New standing orders"');
  expect(result).toContain('"future":123456789012345678901234567890');
  expect(result).toContain('"prompt":"One mission"');
  expect(result).toContain('"value":"Background","unknown":9007199254740993');
  const mission = change("/flow/steps/write", "mission", "New mission");
  expect(propertyChanges(mission.fields, mission.values).map(change => change.path)).toEqual(["/flow/steps/write/prompt"]);
  const information = change("/flow/steps/write", "information", "New background", "brief");
  expect(applyChanges(source, propertyChanges(information.fields, information.values))).toContain('"value":"New background","unknown":9007199254740993');
});
it("changes a choice destination without replacing its message, fan-out or exact numbers", () => {
  const { fields, values } = change("/flow/steps/write", "destination", "other", "approve");
  const result = applyChanges(source, propertyChanges(fields, values));
  expect(result).toContain('"step":"other"');
  expect(result).toContain('"concurrency":9007199254740993');
  expect(result).toContain('"unknown":9007199254740993');
  expect(result).toContain('"prompt":"Review"');
  const terminal = change("/flow/steps/write", "destination", "other", "finish");
  expect(applyChanges(source, propertyChanges(terminal.fields, terminal.values))).toContain('"finish":"other"');
});
it("edits quorum rules with exact integer text and preserves unknown siblings", () => {
  const original = authoringFields030(properties("/flow/steps/vote").fields);
  expect(original.find(field => field.label === "count")?.value).toBe("9007199254740993");
  const accepts = change("/flow/steps/vote", "accept", "approve\nready");
  let result = applyChanges(source, propertyChanges(accepts.fields, accepts.values));
  expect(result).toContain('"count":9007199254740993');
  expect(result).toContain('"accept":["approve","ready"],"unknown":9007199254740993');
  const count = change("/flow/steps/vote", "count", "12345678901234567890");
  result = applyChanges(source, propertyChanges(count.fields, count.values));
  expect(result).toContain('"count":12345678901234567890');
  const all = change("/flow/steps/vote", "joinMode", "all");
  expect(propertyChanges(all.fields, all.values)).toEqual([{ op: "remove", path: "/flow/steps/vote/quorum" }]);
});
it("writes through an occurrence's real source owner", () => {
  const card = projectViewer030(source).graphs[0].cards[0];
  const projected = { ...card, path: "occurrence:reused", edition030: { ...card.edition030!, ownerPath: card.path } };
  const { fields } = componentProperties(source, projected);
  expect(fields.find(field => field.label === "prompt")?.path).toBe("/flow/steps/write/prompt");
  expect(fields.find(field => field.label === "instructions")?.path).toBe("/agents/worker/instructions");
});
it("keeps structured content in exact JSON and adds escaped resource names without rounding", () => {
  const fields = [{ path: "/agents/a/instructions", label: "instructions", value: '[{"value":{"count":9007199254740993}}]', exactJson: true }];
  expect(authoringFields030(fields)).toEqual([]);
  const result = patchAuthoringValue030('{"old":{"value":9007199254740993}}', '/new~1name~0', '{"ref":"guide"}');
  expect(result).toContain('"old":{"value":9007199254740993}');
  expect(result).toContain('"new/name~":{"ref":"guide"}');
});

it("keeps nested content editable when cleared and refuses malformed integer tokens", () => {
  const { fields } = properties("/flow/steps/write");
  const info = authoringFields030(fields).find(field => field.label === "information" && field.name === "brief")!;
  const empty = updateAuthoringField030(fields.map(field => field.value), info, "");
  const cleared = authoringFields030(fields, empty).find(field => field.label === "information" && field.name === "brief")!;
  expect(cleared.value).toBe("");
  expect(updateAuthoringField030(empty, cleared, "New information")[info.index]).toContain('"value":"New information"');
  const join = properties("/flow/steps/vote");
  const count = authoringFields030(join.fields).find(field => field.label === "count")!;
  const values = join.fields.map(field => field.value);
  expect(updateAuthoringField030(values, count, "02")).toBe(values);
});

it("keeps raw line drafts until save and preserves exact JSON edits without normalization", () => {
 const { fields } = properties("/flow/steps/vote");
 const values = fields.map(field => field.value);
 const accept = authoringFields030(fields).find(field => field.label === "accept")!;
 const lineInputs = { [`${accept.index}:${accept.path}`]: "yes\n\nno\n" };
 const raw = authoringValues030(fields, values, lineInputs);
 expect(raw[accept.index]).toContain('"accept":["yes","","no",""]');
 expect(raw[accept.index]).toContain('"count":9007199254740993');
 const saved = authoringValues030(fields, raw, lineInputs, true);
 expect(saved[accept.index]).toContain('"accept":["yes","no"]');
 expect(saved[accept.index]).toContain('"unknown":9007199254740993');
 // The JSON tab is exact, even when an authored list contains an empty value.
 expect(authoringValues030(fields, raw, {}, true)).toEqual(raw);
});
