import { afterEach, beforeEach, expect, it } from "bun:test";
import type { BlueprintSummary } from "../services/ipc/architectLibrary";
import { useArchitectLibraryStore } from "./useArchitectLibraryStore";

const initial = useArchitectLibraryStore.getState();
const blueprint = (id: string, projectId: string): BlueprintSummary =>
  ({ id, projectId, name: id, revision: 1, origin: null, archived: false, conversationId: null });
let lists: Record<string, Array<Promise<BlueprintSummary[]>>>;
let requests: string[];

beforeEach(() => {
  lists = {};
  requests = [];
  Object.defineProperty(window, "__TAURI_INTERNALS__", { configurable: true, value: {
    invoke: async (command: string, args: { projectId?: string }) => {
      if (command === "architect_list_projects") return [{ id: "a", name: "A" }, { id: "b", name: "B" }];
      if (command === "architect_list_blueprints") { requests.push(args.projectId!); return lists[args.projectId!]!.shift()!; }
      throw new Error(command);
    },
  } });
});
afterEach(() => {
  Reflect.deleteProperty(window, "__TAURI_INTERNALS__");
  useArchitectLibraryStore.setState(initial);
});

it("reads every project's blueprints for the tree without selecting any project", async () => {
  lists = { a: [Promise.resolve([blueprint("1", "a")])], b: [Promise.resolve([])] };
  await useArchitectLibraryStore.getState().refreshProjects();
  await useArchitectLibraryStore.getState().refreshAllBlueprints();
  const state = useArchitectLibraryStore.getState();
  expect(state.projectBlueprints.a).toEqual({ status: "ready", value: [blueprint("1", "a")] });
  expect(state.projectBlueprints.b).toEqual({ status: "ready", value: [] });
  expect(state.projectId).toBeNull();
  expect(state.blueprints.status).toBe("idle");
});

it("keeps the last list on screen during a refresh and records a failure per project", async () => {
  lists = { a: [Promise.resolve([blueprint("1", "a")]), Promise.reject(new Error("locked"))] };
  await useArchitectLibraryStore.getState().refreshProjectBlueprints("a");
  const gate = Promise.withResolvers<BlueprintSummary[]>();
  lists.a.unshift(gate.promise);
  const pending = useArchitectLibraryStore.getState().refreshProjectBlueprints("a");
  expect(useArchitectLibraryStore.getState().projectBlueprints.a.status).toBe("ready");
  gate.resolve([blueprint("1", "a"), blueprint("2", "a")]);
  await pending;
  expect(useArchitectLibraryStore.getState().projectBlueprints.a).toMatchObject({ status: "ready", value: [{ id: "1" }, { id: "2" }] });
  await useArchitectLibraryStore.getState().refreshProjectBlueprints("a");
  expect(useArchitectLibraryStore.getState().projectBlueprints.a).toEqual({ status: "error" });
});

it("ignores a slower, older answer for a project", async () => {
  const slow = Promise.withResolvers<BlueprintSummary[]>();
  lists = { a: [slow.promise, Promise.resolve([blueprint("new", "a")])] };
  const first = useArchitectLibraryStore.getState().refreshProjectBlueprints("a");
  await useArchitectLibraryStore.getState().refreshProjectBlueprints("a");
  slow.resolve([blueprint("old", "a")]);
  await first;
  expect(useArchitectLibraryStore.getState().projectBlueprints.a).toMatchObject({ value: [{ id: "new" }] });
});

it("mirrors the selected project's list into the tree", async () => {
  lists = { a: [Promise.resolve([blueprint("1", "a")])] };
  useArchitectLibraryStore.setState({ projectId: "a" });
  await useArchitectLibraryStore.getState().refreshProjectBlueprints("a");
  const state = useArchitectLibraryStore.getState();
  expect(state.blueprints).toEqual({ status: "ready", value: [blueprint("1", "a")] });
  expect(state.projectBlueprints.a).toEqual(state.blueprints);
  expect(requests).toEqual(["a"]);
});
