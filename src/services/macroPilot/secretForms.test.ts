import { expect, it } from "bun:test";
import { secretForms } from "./secretForms";

it("keeps sorted raw, escaped, encoded and nested OAuth token forms", () => {
  const token = 'synthetic/été+"';
  const forms = secretForms([JSON.stringify({ access: token, nested: ["synthetic-refresh"] }), token, ""]);
  expect(forms).toContain(token);
  expect(forms).toContain(encodeURIComponent(token));
  expect(forms).toContain(JSON.stringify(token).slice(1, -1));
  const base64 = Buffer.from(token).toString("base64");
  expect(forms).toContain(base64);
  expect(forms).toContain(base64.replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, ""));
  expect(forms).toContain("synthetic-refresh");
  expect(forms).toEqual([...new Set(forms)].sort());
  expect(secretForms(["{malformed-synthetic"])).toContain("{malformed-synthetic");
});

it("preserves count and encoded-byte resource refusals", () => {
  expect(() => secretForms(Array.from({ length: 4097 }, (_, i) => `synthetic-${i}`))).toThrow("resource_limit");
  expect(() => secretForms(["x".repeat(1024 * 1024 + 1)])).toThrow("resource_limit");
});
