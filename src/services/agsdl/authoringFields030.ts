import { applyChanges, object, pointerPart, scanSource, sourceAt } from "./document";
import type { ComponentProperty } from "./componentProperties";

export interface AuthoringField030 {
  index: number;
  path: string;
  label: string;
  kind: "text" | "multiline" | "select" | "integer" | "lines";
  value: string;
  options?: string[];
  optionLabels?: Record<string, string>;
  group: "general" | "instructions" | "mission" | "information" | "choices" | "instance" | "join";
  name?: string;
}

/** Edit an exact subtree with the same patch engine as the document, never JSON.stringify its parsed owner. */
export function patchAuthoringValue030(value: string, path: string, valueJson?: string): string {
  if (!path) return valueJson ?? "";
  const wrapper = `{"contract":"agsdl-0.4.0","value":${value || "{}"}}`;
  const pointer = `/value${path}`;
  if (valueJson === undefined && !scanSource(wrapper).spans.has(pointer)) return value;
  return sourceAt(applyChanges(wrapper, [{ op: valueJson === undefined ? "remove" : "set", path: pointer, ...(valueJson === undefined ? {} : { valueJson }) }]), "/value");
}

/** Business controls expose only shapes they understand. Every other authored shape stays exact in JSON. */
export function authoringFields030(fields: ComponentProperty[], values = fields.map(field => field.value)): AuthoringField030[] {
  return fields.flatMap((property, index) => {
    const raw = values[index];
    let parsed: ReturnType<typeof scanSource> | undefined;
    let value: unknown;
    try { parsed = raw ? scanSource(raw) : undefined; value = parsed?.tree; } catch { return []; }
    const result: AuthoringField030[] = [];
    const add = (label: string, group: AuthoringField030["group"], kind: AuthoringField030["kind"], path = "", item: unknown = value, options?: string[], name?: string) => {
      if (item !== undefined && !["lines", "integer"].includes(kind) && typeof item !== "string") return;
      if (kind === "lines" && item !== undefined && (!Array.isArray(item) || !item.every(value => typeof value === "string"))) return;
      const span = path ? parsed?.spans.get(path) : undefined;
      const exact = span ? new TextDecoder().decode(parsed!.bytes.subarray(span.start, span.end)) : path ? "" : raw;
      result.push({ index, path, label, group, kind, value: kind === "lines" ? (item as string[] | undefined)?.join("\n") ?? "" : kind === "integer" ? exact || "" : typeof item === "string" ? item : "", options, name });
    };
    const scalarDestination = (group: AuthoringField030["group"]) => {
      const destinations = property.destinations030 ?? [];
      add("destination", group, "select", "", value, destinations.map(option => option.value));
      result.at(-1)!.optionLabels = Object.fromEntries(destinations.map(option => [option.value, option.label]));
    };
    const content = (item: unknown, path: string, label: string, group: AuthoringField030["group"], name?: string) => {
      if (typeof item === "string" || item === undefined) add(label, group, "multiline", path, item, undefined, name);
      else if (Array.isArray(item)) item.forEach((source, i) => content(source, `${path}/${i}`, label, group, `${i + 1}`));
      else if (Array.isArray(object(item).from)) {
        const from = object(item).from as unknown[];
        if (from.every(segment => typeof segment === "string")) add("dataPath", group, "lines", `${path}/from`, from, undefined, name);
      } else for (const key of ["value", "uri", "ref"]) {
        if (typeof object(item)[key] === "string") add(key === "value" ? label : key, group, key === "value" ? "multiline" : "text", `${path}/${key}`, object(item)[key], undefined, name);
      }
    };
    if (property.readonly) return [];
    if (["failures", "maxFailures"].includes(property.label) && fields.some((field, i) => field.label === "quorum" && values[i]?.trim())) return [];
    switch (property.label) {
      case "title": case "description": case "agent": case "composition":
        add(property.label === "description" && property.path.startsWith("/agents/") && fields.some(field => field.label === "type") ? "agentDescription" : property.label, "general", property.label === "description" ? "multiline" : "text"); break;
      case "type": add("workType", "general", "select", "", value, ["agent", "call", "approval", "compose", "join"]); break;
      case "instructions": content(value, "", "instructions", "instructions"); break;
      case "prompt": content(value, "", "mission", "mission"); break;
      case "value": add("information", "information", "multiline"); break;
      case "uri": add("uri", "information", "text"); break;
      case "resources": Object.entries(object(value)).forEach(([name, item]) => content(item, `/${pointerPart(name)}`, "information", "information", name)); break;
      case "instance": add("instance", "instance", "text"); break;
      case "delivery": add("delivery", "instance", "select", "", value, ["queue", "steer"]); break;
      case "remaining": add("remaining", "join", "select", "", value, ["stop", "finish", "wait"]); break;
      case "failures": add("failures", "join", "select", "", value, ["fail", "keep"]); break;
      case "maxFailures": add("maxFailures", "join", "integer"); break;
      case "quorum":
        result.push({ index, path: "", label: "joinMode", group: "join", kind: "select", value: value === undefined ? "all" : "quorum", options: ["all", "quorum"] });
        if (value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value)) {
          add("count", "join", "integer", "/count", object(value).count);
          add("accept", "join", "lines", "/accept", object(value).accept);
        } break;
      case "next":
        if (typeof value === "string") scalarDestination("choices");
        if (typeof object(value).step === "string") {
          add("destination", "choices", "text", "/step", object(value).step);
          const message = object(object(value).message);
          if (message.prompt !== undefined) content(message.prompt, "/message/prompt", "mission", "mission");
          Object.entries(object(message.resources)).forEach(([name, resource]) => content(resource, `/message/resources/${pointerPart(name)}`, "information", "information", name));
        }
        if (value && typeof value === "object" && !Array.isArray(value) && !Object.hasOwn(value, "step") && !Object.hasOwn(value, "output")) {
          Object.entries(object(value)).forEach(([choice, route]) => {
            const path = `/${pointerPart(choice)}`;
            if (Array.isArray(route) && !route.length) add("destination", "choices", "text", path, "", undefined, choice);
            else if (typeof route === "string") add("destination", "choices", "text", path, route, undefined, choice);
            else if (typeof object(route).step === "string") add("destination", "choices", "text", `${path}/step`, object(route).step, undefined, choice);
            if (object(route).message) {
              content(object(object(route).message).prompt, `${path}/message/prompt`, "mission", "mission", choice);
              Object.entries(object(object(object(route).message).resources)).forEach(([name, resource]) => content(resource, `${path}/message/resources/${pointerPart(name)}`, "information", "information", `${choice} · ${name}`));
            }
          });
        } break;
      case "route": {
        if (typeof value === "string") scalarDestination("choices");
        const route = object(value), message = object(route.message);
        if (typeof route.step === "string") add("destination", "general", "text", "/step", route.step);
        if (message.prompt !== undefined) content(message.prompt, "/message/prompt", "mission", "mission");
        Object.entries(object(message.resources)).forEach(([name, resource]) => content(resource, `/message/resources/${pointerPart(name)}`, "information", "information", name));
        break;
      }
    }
    return result;
  });
}

export function updateAuthoringField030(values: string[], field: AuthoringField030, input: string): string[] {
  if (field.label === "destination" && field.kind === "select" && !field.options?.includes(input)) return values;
  if (field.label === "joinMode") return values.map((value, index) => index === field.index ? input === "all" ? "" : value || '{"count":1,"accept":[]}' : value);
  if (field.kind === "integer" && input && !/^(0|[1-9]\d*)$/.test(input)) return values;
  const valueJson = input === "" && (!field.path || field.kind === "integer") ? undefined
    : field.kind === "integer" ? input
    : input === "" && field.label === "destination" && field.path.split("/").length === 2 && field.group === "choices" ? "[]"
    : JSON.stringify(field.kind === "lines" ? input.split("\n") : input);
  return values.map((value, index) => index === field.index ? patchAuthoringValue030(value, field.path, valueJson) : value);
}

/** Keep line-entry drafts separate from exact JSON edits; normalize only when saving. */
export function authoringValues030(fields: ComponentProperty[], values: string[], lineInputs: Record<string, string>, normalize = false): string[] {
  const result = [...values];
  for (const field of authoringFields030(fields, values)) {
    const input = lineInputs[`${field.index}:${field.path}`];
    if (field.kind !== "lines" || input === undefined || (!normalize && input === field.value)) continue;
    const lines = input.split("\n");
    result[field.index] = patchAuthoringValue030(result[field.index], field.path, JSON.stringify(normalize ? lines.filter(Boolean) : lines));
  }
  return result;
}
