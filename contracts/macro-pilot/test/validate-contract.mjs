import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const versionDirectory = join(testDirectory, "..", "v1");
const fixtureDirectory = join(versionDirectory, "fixtures");
const expectedSemanticRejections = new Set([
  "cross-account-session-revoke.json",
  "decision-choice-mismatch.json",
  "decision-command-duplicate-step.json",
  "decision-free-text-disallowed.json",
  "decision-missing-step-answer.json",
  "decreasing-revision.json",
  "event-batch-duplicate-sequence.json",
  "event-resource-mismatch.json",
  "event-revision-mismatch.json",
  "page-type-mismatch.json",
  "review-run-mismatch.json",
  "run-waiting-reference-mismatch.json",
  "task-project-overlap.json",
  "task-target-mismatch.json",
]);

async function readJson(path) {
  return JSON.parse(await readFile(path, "utf8"));
}

async function loadSchemas() {
  const manifest = await readJson(join(versionDirectory, "schema-set.json"));
  const schemas = [];
  const seenIds = new Set();
  for (const resource of manifest.resources) {
    const schema = await readJson(join(versionDirectory, resource.path));
    if (schema.$id !== resource.id) {
      throw new Error(`Schema id mismatch for ${resource.path}: ${schema.$id} !== ${resource.id}`);
    }
    if (seenIds.has(resource.id)) throw new Error(`Duplicate schema id: ${resource.id}`);
    seenIds.add(resource.id);
    schemas.push(schema);
  }
  if (!seenIds.has(manifest.root)) throw new Error(`Root schema absent from registry: ${manifest.root}`);
  return { manifest, schemas };
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
  return sameFields(left, right, ["instance_id", "workspace_id", "task_id", "run_id"]);
}

function duplicateValues(values) {
  return values.filter((value, index) => values.indexOf(value) !== index);
}

function decisionAnswerErrors(steps, answers) {
  const errors = [];
  if (!Array.isArray(steps) || !Array.isArray(answers)) return errors;
  const stepsById = new Map(steps.map((step) => [step.step_id, step]));
  const answerStepIds = answers.map((answer) => answer.step_id);
  if (duplicateValues(answerStepIds).length > 0) {
    errors.push("decision answers contain duplicate step_id values");
  }
  if (answers.length !== steps.length || answerStepIds.some((stepId) => !stepsById.has(stepId))) {
    errors.push("decision resolution does not answer every step exactly once");
  }
  for (const answer of answers) {
    const step = stepsById.get(answer.step_id);
    if (!step) continue;
    if (!step.choices.includes(answer.answer) && step.free_text_allowed !== true) {
      errors.push(`decision answer for ${answer.step_id} uses disallowed free text`);
    }
  }
  return errors;
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

  if (
    message.type === "command" &&
    message.kind === "session.revoke" &&
    message.target?.account_id !== message.issued_by?.account_id
  ) {
    errors.push("session.revoke target belongs to another account");
  }

  if (message.type === "run" && message.waiting_on && !sameRunScope(message.ref, message.waiting_on)) {
    errors.push("run.waiting_on differs from run.ref");
  }

  if (message.type === "task" && Array.isArray(message.project_ids)) {
    const contextProjectIds = Array.isArray(message.context_project_ids) ? message.context_project_ids : [];
    if (message.project_ids.some((projectId) => contextProjectIds.includes(projectId))) {
      errors.push("task project_ids overlap context_project_ids");
    }
    if (Array.isArray(message.execution_targets)) {
      const targetProjectIds = message.execution_targets.map((target) => target.project_id);
      if (
        duplicateValues(targetProjectIds).length > 0 ||
        targetProjectIds.length !== message.project_ids.length ||
        targetProjectIds.some((projectId) => !message.project_ids.includes(projectId))
      ) {
        errors.push("task execution_targets do not match project_ids exactly once");
      }
    }
  }

  if (message.type === "decision" && Array.isArray(message.steps)) {
    const stepIds = message.steps.map((step) => step.step_id);
    if (duplicateValues(stepIds).length > 0) {
      errors.push("decision steps contain duplicate step_id values");
    }
    for (const step of message.steps) {
      if (!Array.isArray(step.choices)) continue;
      if (duplicateValues(step.choices).length > 0) {
        errors.push(`decision step ${step.step_id} contains duplicate choice values`);
      }
    }
    if (message.resolution) {
      errors.push(...decisionAnswerErrors(message.steps, message.resolution.answers));
    }
  }

  if (message.type === "command" && message.kind === "decision.resolve" && Array.isArray(message.payload?.answers)) {
    const answerStepIds = message.payload.answers.map((answer) => answer.step_id);
    if (duplicateValues(answerStepIds).length > 0) {
      errors.push("decision.resolve contains duplicate step_id values");
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

  if (message.type === "event_batch" && Array.isArray(message.events)) {
    let previousSequence = message.after_sequence;
    message.events.forEach((event, index) => {
      if (event.stream_id !== message.stream_id) {
        errors.push(`event_batch.events[${index}] uses another stream_id`);
      }
      if (event.sequence !== previousSequence + 1) {
        errors.push(`event_batch.events[${index}] sequence is not contiguous`);
      }
      previousSequence = event.sequence;
      for (const error of semanticErrors(event)) errors.push(`event_batch.events[${index}]: ${error}`);
    });
    const expectedCursor = message.events.at(-1)?.resume_cursor ?? message.after_cursor;
    if (message.next_cursor !== expectedCursor) {
      errors.push("event_batch.next_cursor does not match the last delivered cursor");
    }
    if (message.next_sequence !== previousSequence) {
      errors.push("event_batch.next_sequence does not match the last delivered sequence");
    }
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

const { manifest, schemas } = await loadSchemas();
for (const schema of schemas) {
  ajv.addSchema(schema);
}

const validate = ajv.getSchema(manifest.root);
if (!validate) throw new Error(`Root schema not found: ${manifest.root}`);

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
  const expectedSemantic = expectedSemanticRejections.has(name);
  const rejectedAsExpected = expectedSemantic ? relationErrors.length > 0 : !schemaValid;
  if (!rejectedAsExpected) {
    failures += 1;
    console.error(`FAIL invalid/${name} was not rejected by ${expectedSemantic ? "semantic rules" : "the schema"}`);
  } else {
    console.log(`PASS invalid/${name} rejected by ${expectedSemantic ? "semantic rules" : "the schema"}`);
  }
}

if (failures > 0) {
  throw new Error(`${failures} contract fixture(s) failed`);
}

console.log("Macro Pilot contract fixtures passed.");
