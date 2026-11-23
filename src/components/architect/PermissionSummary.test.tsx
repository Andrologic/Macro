import { afterEach, expect, it } from "bun:test";
import { PermissionSummary } from "./PermissionSummary";
import { createHost, previewFixture } from "./architectLibrary.testSupport";

let view: ReturnType<typeof createHost>;
afterEach(() => view?.unmount());
const mount = async (element: React.ReactElement) => { view = createHost(); await view.render(element); return view.host; };

it("renders what it can do, the engines and what to prepare as three labelled sections", async () => {
  const host = await mount(<PermissionSummary source={previewFixture()} />);
  const sections = [...host.querySelectorAll("section")].map(section => section.getAttribute("aria-label"));
  expect(sections).toEqual(["What it will be able to do", "Engines and models", "To prepare"]);
});

it("lets the launch step show only the sections it needs", async () => {
  const host = await mount(<PermissionSummary source={previewFixture()} sections={["permissions"]} />);
  expect(host.querySelectorAll("section")).toHaveLength(1);
  expect(host.textContent).not.toContain("GITHUB_TOKEN");
});

it("marks sensitive abilities with an icon and a spoken word, not by colour alone", async () => {
  const host = await mount(<PermissionSummary source={previewFixture()} sections={["permissions"]} />);
  const commands = [...host.querySelectorAll("li")].find(item => item.textContent?.includes("Run commands on this computer"))!;
  expect(commands.querySelector(".sr-only")?.textContent).toContain("Attention:");
  expect(commands.querySelector("svg")).not.toBeNull();
  const read = [...host.querySelectorAll("li")].find(item => item.textContent?.includes("Read files in the execution folder"))!;
  expect(read.querySelector(".sr-only")).toBeNull();
});

it("says so when nothing is asked for", async () => {
  const host = await mount(<PermissionSummary source={previewFixture({ agents: {}, mcpServers: {} })} />);
  expect(host.textContent).toContain("This system asks for no particular permission.");
  expect(host.textContent).toContain("Nothing to prepare before launching.");
  expect(host.textContent).not.toContain("Engines and models");
});

it("asks for secrets only of tools the flow can use, and never shows a value", async () => {
  const preview = previewFixture();
  preview.mcpServers.idle = { usage: "declaredOnly", transport: { type: "local", command: ["uvx", "idle"] }, packagedFiles: [], requiredSecrets: ["IDLE_KEY"] };
  const host = await mount(<PermissionSummary source={preview} sections={["prepare"]} />);
  expect(host.textContent).toContain("GITHUB_TOKEN");
  expect(host.textContent).not.toContain("IDLE_KEY");
  expect(host.textContent).not.toContain("uvx");
});
