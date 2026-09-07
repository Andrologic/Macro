import { useTranslation } from "react-i18next";
import i18n from "../../i18n";
import en from "../../i18n/locales/segments/agsdl-en.json";
import fr from "../../i18n/locales/segments/agsdl-fr.json";
import es from "../../i18n/locales/segments/agsdl-es.json";
import de from "../../i18n/locales/segments/agsdl-de.json";
import ja from "../../i18n/locales/segments/agsdl-ja.json";
import ko from "../../i18n/locales/segments/agsdl-ko.json";

// This module is loaded with the Architect editor, outside the startup locales.
// A separate namespace cannot make the base language look prematurely loaded.
for (const [language, messages] of Object.entries({ en, fr, es, de, ja, ko })) {
  i18n.addResourceBundle(language, "agsdl", { agsdl: messages }, true, true);
}

export const useAgsdlTranslation = () => useTranslation("agsdl");
