import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const read = async (relative) => JSON.parse(await readFile(new URL(relative, import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: true, allErrors: true });
addFormats(ajv);
ajv.addKeyword({ keyword: "x-semantic-rules", schemaType: "array", valid: true });
const registry = await read("../v1/schema-set.json");
for (const resource of registry.resources) ajv.addSchema(await read(`../v1/${resource.path}`));
const validate = ajv.compile(await read("../transport/schema.json"));
const command = await read("../v1/fixtures/valid/command.json");
const exchange = { transport_version: "1.0", type: "exchange", exchange_id: "exchange:synthetic:1", message: command };
const delivery = { ...exchange, type: "delivery", delivery_id: "delivery:synthetic:1", actor: command.issued_by };
const result = { transport_version: "1.0", type: "delivery_result", exchange_id: exchange.exchange_id,
  delivery_id: delivery.delivery_id, message: await read("../v1/fixtures/valid/command-result.json") };
const resumePoint = { stream_id: "stream:synthetic", after_cursor: "cursor:synthetic", after_sequence: 0 };
const taskPage = await read("../v1/fixtures/valid/page.json");

for (const message of [exchange, delivery, result]) assert.equal(validate(message), true, ajv.errorsText(validate.errors));
for (const fixture of ["page-request", "resume-request"]) {
  assert.equal(validate({ ...exchange, message: await read(`../v1/fixtures/valid/${fixture}.json`) }), true);
}
for (const fixture of ["page", "event-batch", "error"]) {
  assert.equal(validate({ ...result, message: await read(`../v1/fixtures/valid/${fixture}.json`),
    ...(fixture === "page" ? { resume_point: resumePoint } : {}) }), true);
}
for (const forbidden of [
  { ...exchange, transport_version: "2.0" },
  { ...exchange, session_token: "synthetic-secret" },
  { ...delivery, instance_key: "synthetic-secret" },
  { ...delivery, actor: { account_id: "account:fake" } },
  { ...exchange, message: await read("../v1/fixtures/valid/session-revoke-command.json") },
  { ...exchange, message: result.message },
  { ...result, message: command },
  { ...result, resume_point: resumePoint },
  { ...result, message: taskPage },
  { ...result, resume_point: { stream_id: "stream:synthetic", after_sequence: -1, after_cursor: "c" } },
]) assert.equal(validate(forbidden), false, "Forbidden transport shape was accepted");
console.log("Native transport envelopes passed: 8 valid and 10 invalid cases.");
