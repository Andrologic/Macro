import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import assert from "node:assert/strict";
import { run, stringify } from "../../src/vendor/agsdl/browser-reader.mjs";

// Supply a checkout of the AgSDL v0.1.0 tag; the corpus remains owned by AgSDL.
const referencePath = process.argv[2];
if (!referencePath)
  throw new Error(
    "Usage: bun dev/agsdl/check-reader-parity.mjs <AgSDL-v0.1.0-checkout>",
  );
const reference = await import(
  pathToFileURL(resolve(referencePath, "tooling/readers/javascript/reader.mjs"))
    .href
);
const fixtures = resolve(referencePath, "conformance/fixtures");
const cases = JSON.parse(
  readFileSync(resolve(fixtures, "manifest.json"), "utf8"),
).cases;
let count = 0;
for (const fixture of cases) {
  if (
    fixture.status !== "ready" ||
    !["validateD", "validateG", "resolveG", "validateR", "exchange"].includes(
      fixture.operation,
    )
  )
    continue;
  const request = {
    operation: fixture.operation,
    primary: readFileSync(resolve(fixtures, fixture.primary.path)),
    annexes: Object.fromEntries(
      Object.entries(fixture.annexes).map(([id, file]) => [
        id,
        readFileSync(resolve(fixtures, file.path)),
      ]),
    ),
  };
  const expected = reference.run(request);
  const actual = await run(request);
  const expectedReport = JSON.parse(reference.stringify(expected.report));
  const actualReport = JSON.parse(stringify(actual.report));
  delete expectedReport.processor;
  delete actualReport.processor;
  assert.deepEqual(actualReport, expectedReport, fixture.name);
  assert.deepEqual(
    Object.keys(actual.artifacts),
    Object.keys(expected.artifacts),
    fixture.name,
  );
  for (const id of Object.keys(expected.artifacts))
    assert.deepEqual(
      [...actual.artifacts[id]],
      [...expected.artifacts[id]],
      fixture.name,
    );
  count++;
}
assert.ok(count > 0, "The reference corpus must contain supported cases.");
console.log(
  `AgSDL reference parity: ${count} cases passed (reports and exchanged bytes).`,
);
