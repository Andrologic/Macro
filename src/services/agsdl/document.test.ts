import { describe, expect, it } from "bun:test";
import {
  applyChanges,
  decodeSource,
  readDocument,
  sourceAt,
  validateDocument,
} from "./document";
import { addAgent, addDefinition, addStep, renameStep } from "./editing";
import { AGSDL_EXAMPLES, createExample } from "./examples";
import { projectDocument } from "./projection";
import { run, stringify } from "../../vendor/agsdl/browser-reader.mjs";

const failures = (reports: Awaited<ReturnType<typeof validateDocument>>) =>
  reports.flatMap((report) =>
    report.results.filter((result) => result.verdict !== "pass"),
  );

describe("AgSDL document authoring", () => {
  it("preserves an imported BOM for diagnostics and rejects invalid UTF-8", () => {
    const imported = decodeSource(
      new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]).buffer,
    );
    expect(imported).toBe("\uFEFF{}");
    expect(() => readDocument(imported)).toThrow();
    expect(() => decodeSource(new Uint8Array([0xff]).buffer)).toThrow();
  });

  it("preserves opaque values, large number tokens, Unicode, and untouched source formatting", () => {
    const source =
      '{ "contract":"agsdl-0.1.0", "opaque":{"big":900719925474099312345,"fraction":1.000e+999}, "title":"é", "a/b~c":0 }';
    const replaced = applyChanges(source, [
      { op: "set", path: "/title", valueJson: '"Édition"' },
    ]);
    expect(replaced).toBe(source.replace('"é"', '"Édition"'));
    const added = applyChanges(replaced, [
      { op: "set", path: "/opaque/new", valueJson: "null" },
      { op: "set", path: "/a~1b~0c", valueJson: "2" },
    ]);
    expect(sourceAt(added, "/opaque/big")).toBe("900719925474099312345");
    expect(sourceAt(added, "/opaque/fraction")).toBe("1.000e+999");
    expect(sourceAt(added, "/a~1b~0c")).toBe("2");
    expect(
      sourceAt(
        applyChanges(added, [{ op: "remove", path: "/opaque/new" }]),
        "/opaque/big",
      ),
    ).toBe("900719925474099312345");
  });

  it("rejects ambiguous JSON, invalid pointers and partial batches", () => {
    const source = createExample("release");
    expect(() => readDocument('{"a":1,"a":2}')).toThrow();
    expect(() =>
      applyChanges(source, [
        {
          op: "set",
          path: "/definitions/0/annotations/title",
          valueJson: '"changed"',
        },
        { op: "remove", path: "/absent/field" },
      ]),
    ).toThrow();
    expect(source).toBe(createExample("release"));
    for (const path of [
      "/__proto__/polluted",
      "/bad~2escape",
      "/graphs/999",
      "/graphs/-1",
    ])
      expect(() => applyChanges(source, [{ op: "remove", path }])).toThrow();
    expect(() =>
      applyChanges('{"contract":"future"}', [
        { op: "set", path: "/x", valueJson: "1" },
      ]),
    ).toThrow();
  });

  for (const example of AGSDL_EXAMPLES)
    it(`${example} passes D/G/R while leaving engine and selection explicit`, async () => {
      const source = createExample(example);
      expect(failures(await validateDocument(source))).toEqual([]);
      const doc = JSON.parse(source);
      expect(doc.runtime.selected).toBeUndefined();
      expect(
        doc.runtime.configurations[0].agents.every(
          (agent: { engine: unknown }) => agent.engine === null,
        ),
      ).toBe(true);
      const projection = projectDocument(source, "process");
      expect(projection.nodes.length).toBe(5);
      expect(projection.edges.length).toBe(6);
    });

  it("renames a step and its graph references without changing opaque instructions", async () => {
    const original = createExample("release");
    const source = applyChanges(
      original,
      renameStep(original, 0, 0, "quality-review"),
    );
    const doc = JSON.parse(source);
    expect(doc.graphs[0].entry).toBe("quality-review");
    expect(failures(await validateDocument(source))).toEqual([]);
    expect(sourceAt(source, "/definitions")).toBe(
      sourceAt(original, "/definitions"),
    );
  });

  it("adds distinct complete agents and compatible definitions; disconnected steps remain diagnostic drafts", async () => {
    let source = createExample("release");
    for (let i = 0; i < 2; i++) source = applyChanges(source, addAgent(source));
    for (const kind of ["Tool", "Instructions", "Skill"])
      source = applyChanges(source, addDefinition(source, kind));
    expect(failures(await validateDocument(source))).toEqual([]);
    const keys = JSON.parse(source).definitions.map((value: { key: unknown }) =>
      JSON.stringify(value.key),
    );
    expect(new Set(keys).size).toBe(keys.length);
    const disconnected = applyChanges(source, addStep(source, 0, "condition"));
    expect(
      failures(await validateDocument(disconnected)).some(
        (result) => result.unit === "G",
      ),
    ).toBe(true);
  });

  it("reports unsupported contracts and invalid routes rather than claiming readiness", async () => {
    const source = createExample("release");
    const broken = applyChanges(source, [
      { op: "set", path: "/graphs/0/steps/0/success", valueJson: '"missing"' },
    ]);
    const results = failures(await validateDocument(broken));
    expect(results.some((result) => result.unit === "G")).toBe(true);
    expect(
      results
        .flatMap((result) => result.findings)
        .some((finding) => finding.location.pointer?.startsWith("/graphs/0")),
    ).toBe(true);
    expect(
      failures(
        await validateDocument(source.replace("agsdl-0.1.0", "future")),
      ).some((result) => result.unit === "D"),
    ).toBe(true);
  });

  it("keeps byte-exact exchange in the browser port, including non-ASCII and unusual number spelling", async () => {
    const source = createExample("release").replace(
      '"annotations": {',
      '"annotations": { "opaque": 1.000e+999, "é": "🙂",',
    );
    const bytes = new TextEncoder().encode(source);
    const result = await run({
      operation: "exchange",
      primary: bytes,
      annexes: {},
    });
    const report = JSON.parse(stringify(result.report));
    expect(report.results.at(-1).verdict).toBe("pass");
    expect(
      Object.values(result.artifacts).some(
        (artifact) => new TextDecoder().decode(artifact) === source,
      ),
    ).toBe(true);
  });
});
