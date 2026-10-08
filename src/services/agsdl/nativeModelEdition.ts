/** Canonical Macro catalogue identities. This codec does not attest availability. */
export interface NativeModelSelection { providerId: string; modelId: string }

function encodeIdentity(value: string): string {
  const bytes = new TextEncoder().encode(value);
  if (!value.trim() || new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) !== value) {
    throw new Error("agsdl.macroConfig.unsupported");
  }
  return btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join(""))
    .replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

export function macroNativeModelEdition(providerId: string, modelId: string) {
  return { identity: `macro/native-model/p/${encodeIdentity(providerId)}/m/${encodeIdentity(modelId)}`, version: "1" };
}

/** Settings may omit identities selected by the Edition, but cannot contradict it. */
export function readMacroNativeModel(model: unknown, settings: unknown): NativeModelSelection | undefined {
  if (!model || typeof model !== "object" || Array.isArray(model) || Object.keys(model).length !== 2) return;
  const edition = model as Record<string, unknown>;
  if (edition.version !== "1" || typeof edition.identity !== "string") return;
  const match = /^macro\/native-model\/p\/([A-Za-z0-9_-]+)\/m\/([A-Za-z0-9_-]+)$/.exec(edition.identity);
  if (!match || (settings !== undefined && (!settings || typeof settings !== "object" || Array.isArray(settings)))) return;
  try {
    const decode = (value: string) => new TextDecoder("utf-8", { fatal: true, ignoreBOM: true })
      .decode(Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0)));
    const providerId = decode(match[1]), modelId = decode(match[2]);
    if (macroNativeModelEdition(providerId, modelId).identity !== edition.identity) return;
    const values = (settings ?? {}) as Record<string, unknown>;
    if ((values.providerId !== undefined && values.providerId !== providerId) ||
        (values.modelId !== undefined && values.modelId !== modelId)) return;
    return { providerId, modelId };
  } catch { return; }
}
