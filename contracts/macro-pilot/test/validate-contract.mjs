import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const versionDirectory = join(testDirectory, "..", "v1");
const fixtureDirectory = join(versionDirectory, "fixtures");
const rootSchemaId = "https://schemas.macro.andrologic.ai/macro-pilot/v1/schema.json";

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadSchemas() {
  const names = (await readdir(versionDirectory))
    .filter((name) => name.endsWith(".schema.json") || name === "schema.json")
    .sort();
  return Promise.all(names.map((name) => readJson(join(versionDirectory, name))));
}

function sameFields(left, right, keys) {
  if (!left || !right) return left === right;
  return keys.every((key) => left[key] === right[key]);
}

function sameReference(left, right) {
  if (!left || !right) return left === right;
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
  return sameFields(left, right, [...keys]);
}

function sameRunScope(left, right) {
  return sameFields(left, right, ["instance_id", "workspace_id", "project_id", "task_id", "run_id"]);
}

function semanticErrors(message) {
  const errors = [];

  if (message.type === "event" && !sameReference(message.resource, message.snapshot?.ref)) {
    errors.push("event.resource differs from event.snapshot.ref");
  }

  if (message.type === "event" && message.revision !== message.snapshot?.revision) {
    errors.push("event.revision differs from event.snapshot.revision");
  }

  if (message.type === "review" && !sameRunScope(message.ref, message.related_run)) {
    errors.push("review.related_run differs from review.ref");
  }

  if (message.type === "run" && message.waiting_on && !sameRunScope(message.ref, message.waiting_on)) {
    errors.push("run.waiting_on differs from run.ref");
  }

  if (message.type === "decision" && Array.isArray(message.choices)) {
    const choiceIdList = message.choices.map((choice) => choice.choice_id);
    const choiceIds = new Set(choiceIdList);
    if (choiceIds.size !== choiceIdList.length) {
      errors.push("decision.choices contains duplicate choice_id values");
    }
    if (message.resolution && !choiceIds.has(message.resolution.choice_id)) {
      errors.push("decision.resolution.choice_id is not present in decision.choices");
    }
  }

  if (
    message.type === "page" &&
    Array.isArray(message.items) &&
    message.items.some((item) => item.type !== message.item_type)
  ) {
    errors.push("page contains an item whose type differs from page.item_type");
  }

  if (message.type === "page" && Array.isArray(message.items)) {
    message.items.forEach((item, index) => {
      for (const error of semanticErrors(item)) errors.push(`page.items[${index}]: ${error}`);
    });
  }

  if (message.type === "event" && message.snapshot) {
    for (const error of semanticErrors(message.snapshot)) errors.push(`event.snapshot: ${error}`);
  }

  if (
    message.type === "command_result" &&
    message.resulting_revision !== undefined &&
    message.resulting_revision < message.previous_revision
  ) {
    errors.push("command_result.resulting_revision is lower than previous_revision");
  }

  return errors;
}

async function fixtureNames(kind) {
  return (await readdir(join(fixtureDirectory, kind)))
    .filter((name) => name.endsWith(".json"))
    .sort();
}

const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
ajv.addKeyword({
  keyword: "x-semantic-rules",
  schemaType: "array",
  metaSchema: { type: "array", items: { type: "string" } },
  valid: true,
});

for (const schema of await loadSchemas()) {
  ajv.addSchema(schema);
}

const validate = ajv.getSchema(rootSchemaId);
if (!validate) throw new Error(`Root schema not found: ${rootSchemaId}`);

let failures = 0;
for (const name of await fixtureNames("valid")) {
  const fixture = await readJson(join(fixtureDirectory, "valid", name));
  const schemaValid = validate(fixture);
  const relationErrors = semanticErrors(fixture);
  if (!schemaValid || relationErrors.length > 0) {
    failures += 1;
    console.error(`FAIL valid/${name}`);
    if (!schemaValid) console.error(ajv.errorsText(validate.errors, { separator: "\n  " }));
    for (const error of relationErrors) console.error(`  ${error}`);
  } else {
    console.log(`PASS valid/${name}`);
  }
}

for (const name of await fixtureNames("invalid")) {
  const fixture = await readJson(join(fixtureDirectory, "invalid", name));
  const schemaValid = validate(fixture);
  const relationErrors = semanticErrors(fixture);
  if (schemaValid && relationErrors.length === 0) {
    failures += 1;
    console.error(`FAIL invalid/${name} was accepted`);
  } else {
    console.log(`PASS invalid/${name} rejected`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} contract fixture(s) failed`);
}

console.log("Macro Pilot contract fixtures passed.");
