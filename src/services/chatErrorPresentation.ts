export type ChatErrorOrigin = "macro" | "provider";
export type ChatErrorDisplayTarget = "composer" | "transcript";

export interface ChatErrorPresentationContext {
  providerId?: string | null;
  providerType?: string | null;
  modelId?: string | null;
}

export interface ChatErrorPresentation {
  origin: ChatErrorOrigin;
  displayTarget: ChatErrorDisplayTarget;
  title: string;
  message: string;
  suggestedAction?: string;
  provider?: string;
  providerType?: string;
  model?: string;
  kind?: string;
  status?: number;
  retryable?: boolean;
  retryAfterMs?: number;
  code?: string;
  type?: string;
  rawExcerpt?: string;
}

const MAX_DETAIL_LENGTH = 1200;
const MAX_MESSAGE_LENGTH = 900;

const truncateText = (value: string, maxLength: number): string => {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd()}...`;
};

const getErrorRecord = (error: unknown): Record<string, unknown> =>
  error && typeof error === "object" ? (error as Record<string, unknown>) : {};

const getErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error ?? "Unknown error");
};

export const isProviderErrorLike = (error: unknown): boolean => {
  const record = getErrorRecord(error);
  if (record.name === "ProviderRuntimeError" || record.providerError === true) {
    return true;
  }
  const kind = record.kind;
  return (
    typeof kind === "string" &&
    (typeof record.retryable === "boolean" ||
      typeof record.status === "number" ||
      "retryAfterMs" in record)
  );
};

const getSuggestedProviderAction = (params: {
  kind?: string;
  retryable?: boolean;
  retryAfterMs?: number;
}): string => {
  switch (params.kind) {
    case "auth":
      return "Vérifie la clé API ou reconnecte le provider, puis relance le message.";
    case "context_overflow":
      return "Utilise un modèle avec une fenêtre de contexte plus grande ou compacte davantage la conversation avant de relancer.";
    case "rate_limited":
      return params.retryAfterMs
        ? `Attends environ ${Math.ceil(params.retryAfterMs / 1000)} secondes, puis relance.`
        : "Attends quelques instants, puis relance.";
    case "provider_overloaded":
    case "stream_idle_timeout":
    case "network":
      return "Relance dans quelques instants. Si l'erreur persiste, vérifie la disponibilité du provider.";
    case "unsupported_reasoning":
      return "Désactive le raisonnement pour ce modèle ou choisis un modèle compatible.";
    case "invalid_tool_protocol":
      return "Relance après compaction stricte. Si l'erreur persiste, l'historique d'outils ancien est probablement invalide pour ce provider.";
    default:
      return params.retryable
        ? "Relance dans quelques instants."
        : "Vérifie le provider, le modèle sélectionné et les paramètres de la requête.";
  }
};

export const resolveChatErrorPresentation = (
  error: unknown,
  context: ChatErrorPresentationContext = {},
): ChatErrorPresentation => {
  const message = truncateText(getErrorMessage(error), MAX_MESSAGE_LENGTH);
  if (!isProviderErrorLike(error)) {
    return {
      origin: "macro",
      displayTarget: "composer",
      title: "Erreur Macro",
      message,
      suggestedAction: "Corrige le problème indiqué, puis relance l'action.",
    };
  }

  const record = getErrorRecord(error);
  const kind = typeof record.kind === "string" ? record.kind : undefined;
  const status =
    typeof record.status === "number" && Number.isFinite(record.status)
      ? record.status
      : undefined;
  const retryAfterMs =
    typeof record.retryAfterMs === "number" && Number.isFinite(record.retryAfterMs)
      ? record.retryAfterMs
      : undefined;
  const retryable =
    typeof record.retryable === "boolean" ? record.retryable : undefined;
  const code =
    typeof record.providerCode === "string"
      ? record.providerCode
      : typeof record.code === "string"
        ? record.code
        : undefined;
  const type =
    typeof record.providerType === "string"
      ? record.providerType
      : typeof record.type === "string"
        ? record.type
        : undefined;
  const rawExcerpt =
    typeof record.providerRawBodyExcerpt === "string"
      ? truncateText(record.providerRawBodyExcerpt, MAX_DETAIL_LENGTH)
      : undefined;
  const providerMessage =
    typeof record.providerMessage === "string"
      ? truncateText(record.providerMessage, MAX_MESSAGE_LENGTH)
      : message;

  return {
    origin: "provider",
    displayTarget: "transcript",
    title: "Erreur du provider",
    message: providerMessage,
    suggestedAction: getSuggestedProviderAction({
      kind,
      retryable,
      retryAfterMs,
    }),
    provider: context.providerId ?? undefined,
    providerType: context.providerType ?? undefined,
    model: context.modelId ?? undefined,
    kind,
    status,
    retryable,
    retryAfterMs,
    code,
    type,
    rawExcerpt,
  };
};

const formatLine = (label: string, value: string | number | boolean | undefined): string | null => {
  if (value === undefined || value === "") {
    return null;
  }
  return `- ${label}: \`${String(value)}\``;
};

export const buildProviderErrorTranscriptMarkdown = (
  presentation: ChatErrorPresentation,
): string => {
  const lines = [
    `### ${presentation.title}`,
    "",
    presentation.message,
    "",
    ...[
      formatLine("Provider", presentation.provider),
      formatLine("Type provider", presentation.providerType),
      formatLine("Modèle", presentation.model),
      formatLine("Type d'erreur", presentation.kind),
      formatLine("Statut HTTP", presentation.status),
      formatLine("Code", presentation.code),
      formatLine("Catégorie", presentation.type),
      formatLine("Réessayable", presentation.retryable),
      formatLine(
        "Retry après",
        presentation.retryAfterMs === undefined
          ? undefined
          : `${Math.ceil(presentation.retryAfterMs / 1000)}s`,
      ),
    ].filter((line): line is string => Boolean(line)),
    "",
    `Action recommandée: ${presentation.suggestedAction ?? "Relance la demande ou change de provider."}`,
  ];

  if (presentation.rawExcerpt) {
    lines.push("", "Détail brut provider:", "", "```text", presentation.rawExcerpt, "```");
  }

  return lines.join("\n").trim();
};
