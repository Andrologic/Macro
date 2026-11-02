import { create } from "zustand";
import { executionModelChoices } from "../services/tauriIpc";
import type { NativeModelCatalogue, NativeModelChoice } from "../types/generated/ipc";
import { macroNativeModelEdition } from "../services/agsdl/nativeModelEdition";

/** Catalogue identities are qualified natively; global chat preferences never supply a choice. */
export function qualifiedModel(catalogue: NativeModelCatalogue | undefined, providerId: string, modelId: string): NativeModelChoice | undefined {
  const matches = catalogue?.models.filter(model => model.providerId === providerId && model.modelId === modelId) ?? [];
  const choice = matches.length === 1 ? matches[0] : undefined;
  if (!choice || choice.edition.identity !== macroNativeModelEdition(providerId, modelId).identity || choice.edition.version !== "1") return;
  return choice;
}
interface CatalogueState {
  catalogue?: NativeModelCatalogue;
  loading: boolean;
  error?: string;
  load: (refresh?: boolean) => Promise<NativeModelCatalogue>;
}
let pending: Promise<NativeModelCatalogue> | undefined;
export const useAgsdlModelCatalogue = create<CatalogueState>((set, get) => ({
  loading: false,
  async load(refresh = false) {
    if (pending) return pending;
    if (!refresh && get().catalogue) return get().catalogue!;
    set({ loading: true, error: undefined });
    pending = executionModelChoices().then(catalogue => {
      set({ catalogue, loading: false });
      return catalogue;
    }).catch(error => {
      set({ catalogue: undefined, loading: false, error: String(error) });
      throw error;
    }).finally(() => { pending = undefined; });
    return pending;
  },
}));
