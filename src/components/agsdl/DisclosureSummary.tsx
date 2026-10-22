import type { ReactNode } from "react";
import { ChevronDown } from "lucide-react";

/** Native disclosure semantics, with the same chevron used by Macro's accordions. */
export function DisclosureSummary({ children }: { children: ReactNode }) {
  return <summary className="agsdl-disclosure-summary"><span className="agsdl-disclosure-label">{children}</span><ChevronDown size={14} aria-hidden="true" className="agsdl-disclosure-chevron" /></summary>;
}
