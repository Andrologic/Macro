import { afterEach, expect, it, mock } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useAgsdlStore, agsdlSessionKey } from "../../stores/useAgsdlStore";
import type { AgsdlChange } from "../../types/agsdl";
mock.module("./WorkflowGraph", () => ({ WorkflowGraph: ({select}: {select:(path:string)=>void}) => <button onClick={()=>select("/flow/steps/a/next")}>Route QA</button> }));
const { AgsdlEditor } = await import("./AgsdlEditor");
const target={branchName:"develop",planId:"route-qa"}, key=agsdlSessionKey(target);
const source='{"contract":"agsdl-0.3.0","id":"x","agents":{},"flow":{"entry":"a","steps":{"a":{"type":"call","command":"echo source","next":"b"},"b":{"type":"call","command":"echo target"}}}}';
let root:Root|undefined, host:HTMLDivElement;
const original={load:useAgsdlStore.getState().load,validate:useAgsdlStore.getState().validate,edit:useAgsdlStore.getState().edit,save:useAgsdlStore.getState().save};
afterEach(()=>{act(()=>root?.unmount());host?.remove();mock.restore();useAgsdlStore.setState({...original,sessions:{}});});
async function mount(edit = true){
 const session={source,annexes:{},version:"initial",persistedRevision:1,dirty:false,saving:false,status:"draft" as const,history:[],future:[],reports:[],error:null};
 useAgsdlStore.setState({sessions:{[key]:session},load:async()=>session,validate:async()=>{}});
 host=document.createElement("div");document.body.appendChild(host);root=createRoot(host);
 await act(async()=>root!.render(<AgsdlEditor target={target}/>));
 act(()=>Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent==="Route QA")!.click());
 expect(document.body.querySelector(".agsdl-edge-summary")?.textContent).toContain("a");
 expect(document.body.querySelector(".agsdl-edge-summary")?.textContent).toContain("b");
 expect(document.body.querySelectorAll(".agsdl-edge-endpoints button")).toHaveLength(2);
 if (edit) act(()=>Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find(b=>b.textContent==="Edit component")!.click());
}
function value(text:string){act(()=>{const input=document.body.querySelector("textarea")!;Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value")!.set!.call(input,text);input.dispatchEvent(new Event("input",{bubbles:true}));});}
function terminal(){useAgsdlStore.setState(state=>({sessions:{...state.sessions,[key]:{...state.sessions[key],version:"updated",source:source.replace('"next":"b"','"next":[]')}}}));}
it("keeps a route draft after concurrent edge removal",async()=>{
 await mount();value('"private-target"');act(terminal);
 expect(document.body.querySelector("textarea")?.value).toBe('"private-target"');
 await act(async()=>document.body.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(document.body.querySelector('[role="alert"]')?.textContent).toContain("document changed");
});
it("keeps retry after an applied terminal route loses its edge and persistence fails",async()=>{
 await mount();value("[]");
 // Simulate only the not-yet-integrated 01 patch boundary; exercise real UI retry state.
 const edits:AgsdlChange[][]=[];
 useAgsdlStore.setState({edit:(_target,changes)=>{edits.push(changes);terminal();},save:async()=>{throw new Error("synthetic save failure");}});
 await act(async()=>document.body.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(document.body.querySelector("textarea")?.value).toBe("[]");
 expect(document.body.querySelector('[role="alert"]')).not.toBeNull();
 await act(async()=>document.body.querySelector("form")!.dispatchEvent(new Event("submit",{bubbles:true,cancelable:true})));
 expect(edits).toHaveLength(1);
});

it("navigates both endpoints and returns to the route, then guards a draft on close", async () => {
 await mount(false);
 for (const label of ['a', 'b']) {
  const endpoint = Array.from(document.body.querySelectorAll<HTMLButtonElement>('.agsdl-edge-endpoints button')).find(button => button.textContent === label)!;
  act(() => endpoint.click());
  expect(document.body.querySelector('[role="dialog"] header strong')?.textContent).toBe(label);
  expect(document.body.querySelector('[role=dialog] .agsdl-source-value')?.textContent).toContain(label === 'a' ? 'echo source' : 'echo target');
  act(() => Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(button => button.textContent === 'Back to previous details')!.click());
  expect(document.body.querySelectorAll('.agsdl-edge-endpoints button')).toHaveLength(2);
 }
 act(()=>Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Edit component')!.click());
 value('"private-target"');
 act(()=>Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Close')!.click());
 expect(document.body.querySelectorAll('[role="dialog"]')).toHaveLength(2);
 expect(document.body.querySelector('textarea')?.value).toBe('"private-target"');
});
