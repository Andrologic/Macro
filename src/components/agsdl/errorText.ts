import type { TFunction } from "i18next";
import i18n from "../../i18n";
import { AgsdlUserError } from "../../services/agsdl/userErrors";

/** Interface text for a failed AgSDL action: a translated reason the user can act
 * on, otherwise a short retry hint. Transport and native details stay out. */
export function agsdlErrorText(error: unknown, t: TFunction = i18n.getFixedT(null, "agsdl"), fallbackKey = "agsdl.actionFailed"): string {
  if (error instanceof AgsdlUserError) return t(error.messageKey);
  const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
  if (message.startsWith("agsdl.") && i18n.exists(message, { ns: "agsdl" })) return t(message);
  return t(fallbackKey);
}
