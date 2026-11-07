import { expect, it } from "bun:test";
import { projectViewer030 } from "./viewer030";
import { componentProperties, propertyChanges } from "./componentProperties";
import { agentModelChanges030, macroAgentConfiguration } from "./macroAgentConfiguration";
import { renameStep, addAgent, addStep } from "./editing";

const source = `{"contract":"agsdl-0.3.0","id":"demo","agents":{"a":{"harness":"codex","permissions":"read-only","harnessSettings":{"n":9007199254740993},"model":{"effort":"private-effort"}}},"flow":{"entry":"a","onError":{"step":"a"},"steps":{"a":{"type":"agent","agent":"a","next":{"failure":"b","done":[]}},"b":{"type":"approval","next":{"again":{"step":"a","message":{"resources":{"literal":{"value":{"step":"a","n":9007199254740993}}}}},"stop":[]}}}}}`;
it("offers every standard agent property, exact subtrees, and independent optional model fields", () => {
 const card = projectViewer030(source).declarations.find(card => card.path === "/agents/a")!;
 const properties = componentProperties(source, card);
 expect(properties.fields).toHaveLength(17);
 expect(properties.fields.find(field => field.label === "harnessSettings")?.value).toBe('{"n":9007199254740993}');
 const values = properties.fields.map(field => field.label === "maxCorrections" ? "0" : field.value);
 expect(propertyChanges(properties.fields, values)).toEqual([{op:"set",path:"/agents/a/maxCorrections",valueJson:"0"}]);
 expect(macroAgentConfiguration(source, card)).toMatchObject({edition030:true,modelId:"",effort:"private-effort"});
 expect(agentModelChanges030(source,"/agents/a",{effort:"new-private"})).toEqual([{op:"set",path:"/agents/a/model/effort",valueJson:'"new-private"'}]);
 expect(agentModelChanges030(source,"/agents/a",{})).toEqual([{op:"remove",path:"/agents/a/model/effort"}]);
});
it("rejects malformed exact JSON and missing required properties before producing patches", () => {
 const card = projectViewer030(source).declarations.find(card => card.path === "/agents/a")!;
 const props = componentProperties(source, card);
 expect(() => propertyChanges(props.fields,props.fields.map(field => field.label === "permissions" ? "" : field.value))).toThrow();
 expect(() => propertyChanges(props.fields,props.fields.map(field => field.label === "permissions" ? '{"a":1,"a":2}' : field.value))).toThrow();
});
it("renames scalar and object targets in their scope without touching literal data", () => {
 const changes = renameStep(source,0,0,"renamed");
 expect(changes).toContainEqual({op:"set",path:"/flow/onError/step",valueJson:'"renamed"'});
 expect(changes).toContainEqual({op:"set",path:"/flow/steps/b/next/again/step",valueJson:'"renamed"'});
 expect(changes.some(change => change.path.includes("/message/"))).toBe(false);
 expect(changes[0].valueJson).toContain('"failure":"b"');
 expect(addAgent(source).some(change => change.path.includes("configurations"))).toBe(false);
});
it("creates a string call command and permits absent join.next and parameterless compose.agents", () => {
 const call = addStep(source, 0, "call")[0];
 expect(typeof JSON.parse(call.valueJson!).command).toBe("string");
 const doc = '{"contract":"agsdl-0.3.0","id":"x","agents":{},"flow":{"entry":"j","steps":{"j":{"type":"join","next":[]},"c":{"type":"compose","composition":"empty","agents":{},"next":{"done":[]}}}},"compositions":{"empty":{"entry":"j","steps":{"j":{"type":"join"}},"outputs":["done"]}}}';
 const cards = projectViewer030(doc).graphs[0].cards;
 for (const [index, name] of [[0, "next"], [1, "agents"]] as const) {
  const props = componentProperties(doc, cards[index]);
  expect(propertyChanges(props.fields,props.fields.map(field=>field.label===name ? "" : field.value))).toContainEqual({op:"remove",path:`${cards[index].path}/${name}`});
 }
});
