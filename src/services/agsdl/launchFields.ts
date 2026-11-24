export const MAX_LAUNCH_FIELDS = 16;
const MAX_TEXT_BYTES = 4096;
const utf8 = new TextEncoder();

export const launchFieldTypes = ["text", "number", "boolean"] as const;

export interface LaunchField {
  key: string;
  label: string;
  type: typeof launchFieldTypes[number];
  required: boolean;
}

export interface LaunchFields {
  version: "macro-launch-fields/1";
  fields: LaunchField[];
}

export type LaunchValues = Record<string, string | number | boolean>;

export function validLaunchFields(fields: LaunchField[]): boolean {
  return fields.length <= MAX_LAUNCH_FIELDS
    && new Set(fields.map(field => field.key)).size === fields.length
    && fields.every(field => /^[A-Za-z]/.test(field.key) && !/[^A-Za-z0-9_]/.test(field.key) && field.key.length <= 64
      && /[^\p{White_Space}]/u.test(field.label)
      && !/\p{Cc}/u.test(field.label)
      && [...field.label].length <= 80);
}

/** Stored settings can also contain opaque launchFields from older Macro versions. */
export function readLaunchFields(stored: unknown): LaunchFields | undefined {
  if (!stored || typeof stored !== "object" || !("version" in stored) || stored.version !== "macro-launch-fields/1"
      || !("fields" in stored) || !Array.isArray(stored.fields)) return undefined;
  return { version: stored.version, fields: stored.fields };
}

function decimalIdentity(raw: string): string | undefined {
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(raw);
  if (!match) return undefined;
  const fraction = match[3] ?? match[4] ?? "";
  const digits = `${match[2] ?? ""}${fraction}`.replace(/^0+/, "");
  if (digits === "") return "0";
  const significant = digits.replace(/0+$/, "");
  const exponent = Number(match[5] ?? 0) - fraction.length + digits.length - significant.length;
  if (!Number.isSafeInteger(exponent)) return undefined;
  return `${match[1] === "-" ? "-" : ""}${significant}e${exponent}`;
}

export function launchFieldValue(field: LaunchField, raw: string): LaunchValues[string] | undefined {
  if (!/[^\p{White_Space}]/u.test(raw)) return undefined;
  switch (field.type) {
    case "text": return utf8.encode(raw).byteLength <= MAX_TEXT_BYTES ? raw : undefined;
    case "number": {
      const number = Number(raw);
      if (!Number.isFinite(number) || (Number.isInteger(number) && !Number.isSafeInteger(number))) return undefined;
      const decimal = decimalIdentity(raw.trim());
      return decimal !== undefined && decimal === decimalIdentity(number.toString()) ? number : undefined;
    }
    case "boolean": return raw === "true" ? true : raw === "false" ? false : undefined;
  }
}

export function parseLaunchValues(fields: LaunchFields, raw: ReadonlyMap<string, string>): LaunchValues | null {
  const entries: Array<[string, LaunchValues[string]]> = [];
  for (const field of fields.fields) {
    const input = raw.get(field.key) ?? "";
    if (!field.required && !/[^\p{White_Space}]/u.test(input)) continue;
    const value = launchFieldValue(field, input);
    if (value === undefined) return null;
    entries.push([field.key, value]);
  }
  return Object.fromEntries(entries);
}
