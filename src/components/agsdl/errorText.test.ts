import { afterEach, expect, it } from "bun:test";
import i18n from "../../i18n";
import "./useAgsdlTranslation";
import { agsdlErrorText } from "./errorText";
import { AgsdlUserError } from "../../services/agsdl/userErrors";

afterEach(async () => { await i18n.changeLanguage("en"); });

it("shows translated reasons the user can act on and a short retry hint for anything else", async () => {
  await i18n.changeLanguage("fr");
  const conflict = new AgsdlUserError("agsdl.viewer.editConflict", "The document changed. Read it again before editing.");
  // The thrown message stays the English text agents read.
  expect(conflict.message).toBe("The document changed. Read it again before editing.");
  expect(agsdlErrorText(conflict)).toBe(i18n.t("agsdl.viewer.editConflict", { ns: "agsdl" }));
  expect(agsdlErrorText(new AgsdlUserError("agsdl.userError.nameRequired", "Give the blueprint a name."))).toBe("Donnez un nom au blueprint.");
  expect(agsdlErrorText(new Error("agsdl.execution.promptRequired"))).toBe(i18n.t("agsdl.execution.promptRequired", { ns: "agsdl" }));
  for (const failure of [{ code: "UNEXPECTED_ERROR", message: "sqlite: disk I/O error" }, new Error("Runtime snapshot source differs"), "native failure", new TypeError("x is undefined")]) {
    expect(agsdlErrorText(failure)).toBe("L’action a échoué. Réessayez.");
  }
  expect(agsdlErrorText(new Error("boom"), undefined, "agsdl.execution.taskUnavailable")).toBe(i18n.t("agsdl.execution.taskUnavailable", { ns: "agsdl" }));
});
