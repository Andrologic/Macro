import { expect, it } from "bun:test";
import { launchFieldValue, type LaunchField } from "./launchFields";

it("only accepts decimal values that can be transmitted without changing their value", () => {
  const field: LaunchField = { key: "ticket", label: "Ticket", type: "number", required: true };
  for (const raw of ["9007199254740993", "1e-324", "0.12345678901234567899", "0x10", "Infinity"]) {
    expect(launchFieldValue(field, raw)).toBeUndefined();
  }
  for (const [raw, expected] of [["9007199254740991", 9007199254740991], ["001.2500e1", 12.5], [".1", 0.1], ["0", 0]] as const) {
    expect(launchFieldValue(field, raw)).toBe(expected);
  }
});
