const CHARS_PER_TOKEN = 4;
const IMAGE_REFERENCE_KEYS = new Set(['image_url', 'imageurl']);
const IMAGE_CONTAINER_TYPES = new Set(['image', 'image_url', 'input_image']);

export type ImageDetail = 'low' | 'high' | 'original' | 'auto';
export type ImageTokenEstimateConfidence =
  | 'model_formula'
  | 'provider_formula'
  | 'fallback'
  | 'unknown';

export interface ImageContextMetadata {
  width?: number;
  height?: number;
  mimeType?: string;
  detail?: ImageDetail;
  sourceFingerprint?: string;
}

export interface MultimodalTokenContext {
  providerType?: string | null;
  providerId?: string | null;
  baseUrl?: string | null;
  modelId?: string | null;
}

export interface ImageTokenEstimate {
  tokens: number;
  source:
    | 'openai_patch'
    | 'openai_tile'
    | 'anthropic_patches'
    | 'gemini_tiles'
    | 'dimension_fallback'
    | 'unknown_dimensions';
  confidence: ImageTokenEstimateConfidence;
  hasKnownDimensions: boolean;
}

export interface StructuredContextTokenEstimate {
  totalTokens: number;
  textTokens: number;
  imageTokens: number;
  imageCount: number;
  imagesWithKnownDimensions: number;
  imageTransportBytes: number;
  imageEstimateConfidence: ImageTokenEstimateConfidence;
  imageEstimateSources: ImageTokenEstimate['source'][];
}

interface SanitizedTokenValue {
  value: unknown;
  imageEstimates: ImageTokenEstimate[];
  imageTransportBytes: number;
}

interface SanitizeState {
  seen: WeakSet<object>;
  imageMetadata: ImageContextMetadata[];
  usedImageMetadataIndexes: Set<number>;
  context: MultimodalTokenContext;
}

interface PatchProfile {
  maxDimension: number;
  patchBudget?: number;
  multiplier: number;
  confidence: ImageTokenEstimateConfidence;
}

interface TileProfile {
  baseTokens: number;
  tileTokens: number;
  confidence: ImageTokenEstimateConfidence;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

const normalizeDimension = (value?: number): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.max(1, Math.round(value))
    : null;

const normalizeDetail = (value: unknown): ImageDetail | undefined =>
  value === 'low' || value === 'high' || value === 'original' || value === 'auto'
    ? value
    : undefined;

const normalizedProviderFingerprint = (context: MultimodalTokenContext): string =>
  [context.providerType, context.providerId, context.baseUrl, context.modelId]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();

const normalizedModelId = (context: MultimodalTokenContext): string =>
  (context.modelId || '').trim().toLowerCase();

const hasModelFamily = (modelId: string, family: string): boolean =>
  new RegExp(`(^|[/:_.-])${family.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}($|[/:_.-])`, 'i')
    .test(modelId);

const fitWithinDimension = (
  width: number,
  height: number,
  maxDimension: number
): { width: number; height: number } => {
  const scale = Math.min(1, maxDimension / width, maxDimension / height);
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
};

const estimatePatchTokens = (
  width: number,
  height: number,
  profile: PatchProfile
): number => {
  let resized = fitWithinDimension(width, height, profile.maxDimension);
  const patchCount = () =>
    Math.ceil(resized.width / 32) * Math.ceil(resized.height / 32);

  if (profile.patchBudget && patchCount() > profile.patchBudget) {
    const scale = Math.sqrt(
      (32 * 32 * profile.patchBudget) / (resized.width * resized.height)
    );
    const scaledWidth = resized.width * scale;
    const scaledHeight = resized.height * scale;
    const adjustedScale =
      scale *
      Math.min(
        Math.floor(scaledWidth / 32) / (scaledWidth / 32),
        Math.floor(scaledHeight / 32) / (scaledHeight / 32)
      );
    resized = {
      width: Math.max(1, Math.floor(resized.width * adjustedScale)),
      height: Math.max(1, Math.floor(resized.height * adjustedScale)),
    };
  }

  return Math.ceil(patchCount() * profile.multiplier);
};

const estimateTileTokens = (
  width: number,
  height: number,
  detail: ImageDetail,
  profile: TileProfile
): number => {
  if (detail === 'low') return profile.baseTokens;

  let resized = fitWithinDimension(width, height, 2048);
  const shortestSide = Math.min(resized.width, resized.height);
  if (shortestSide > 768) {
    const scale = 768 / shortestSide;
    resized = {
      width: Math.max(1, Math.floor(resized.width * scale)),
      height: Math.max(1, Math.floor(resized.height * scale)),
    };
  }
  const tiles = Math.ceil(resized.width / 512) * Math.ceil(resized.height / 512);
  return profile.baseTokens + tiles * profile.tileTokens;
};

const resolveOpenAiPatchProfile = (
  modelId: string,
  detail: ImageDetail
): PatchProfile | null => {
  if (/gpt-5\.6(?:-|$)/.test(modelId)) {
    if (detail === 'low') {
      return { maxDimension: 512, multiplier: 1.2, confidence: 'model_formula' };
    }
    if (detail === 'high') {
      return {
        maxDimension: 2048,
        patchBudget: 2500,
        multiplier: 1.2,
        confidence: 'model_formula',
      };
    }
    return { maxDimension: 65_535, multiplier: 1.2, confidence: 'model_formula' };
  }

  if (hasModelFamily(modelId, 'gpt-5.5')) {
    if (detail === 'low') {
      return { maxDimension: 512, multiplier: 1.2, confidence: 'model_formula' };
    }
    if (detail === 'high') {
      return {
        maxDimension: 2048,
        patchBudget: 2500,
        multiplier: 1.2,
        confidence: 'model_formula',
      };
    }
    return {
      maxDimension: 6000,
      patchBudget: 10_000,
      multiplier: 1.2,
      confidence: 'model_formula',
    };
  }

  if (/gpt-5\.4(?:-|$)/.test(modelId)) {
    const original = detail === 'original';
    return {
      maxDimension: original ? 6000 : 2048,
      patchBudget: original ? 10_000 : detail === 'low' ? 6144 : 2500,
      multiplier: 1.2,
      confidence: 'model_formula',
    };
  }

  if (hasModelFamily(modelId, 'gpt-5.2')) {
    return {
      maxDimension: 2048,
      patchBudget: 6144,
      multiplier: 1.2,
      confidence: 'model_formula',
    };
  }

  if (hasModelFamily(modelId, 'gpt-4.1-mini')) {
    return {
      maxDimension: 2048,
      patchBudget: 6144,
      multiplier: 1.62,
      confidence: 'model_formula',
    };
  }

  if (hasModelFamily(modelId, 'gpt-4.1-nano')) {
    return {
      maxDimension: 2048,
      patchBudget: 6144,
      multiplier: 2.46,
      confidence: 'model_formula',
    };
  }

  return null;
};

const resolveOpenAiTileProfile = (modelId: string): TileProfile | null => {
  if (hasModelFamily(modelId, 'gpt-4o-mini')) {
    return { baseTokens: 2833, tileTokens: 5667, confidence: 'model_formula' };
  }
  if (hasModelFamily(modelId, 'gpt-4o') || hasModelFamily(modelId, 'gpt-4.1')) {
    return { baseTokens: 85, tileTokens: 170, confidence: 'model_formula' };
  }
  if (hasModelFamily(modelId, 'gpt-5.1')) {
    return { baseTokens: 70, tileTokens: 140, confidence: 'model_formula' };
  }
  if (
    hasModelFamily(modelId, 'o1') ||
    hasModelFamily(modelId, 'o1-pro') ||
    hasModelFamily(modelId, 'o3')
  ) {
    return { baseTokens: 75, tileTokens: 150, confidence: 'model_formula' };
  }
  return null;
};

const resolveAnthropicResolutionTier = (
  modelId: string
): { maxEdge: number; maxTokens: number } => {
  const version = modelId.match(
    /claude(?:-[a-z]+)*-(\d+)(?:[.-](\d+))?/
  );
  const major = Number(version?.[1] ?? 0);
  const minor = Number(version?.[2] ?? 0);
  return major > 4 || (major === 4 && minor >= 7)
    ? { maxEdge: 2576, maxTokens: 4784 }
    : { maxEdge: 1568, maxTokens: 1568 };
};

const estimateAnthropicTokens = (
  width: number,
  height: number,
  modelId: string
): number => {
  const { maxEdge, maxTokens } = resolveAnthropicResolutionTier(modelId);
  const countTokens = (candidateWidth: number, candidateHeight: number) =>
    Math.ceil(candidateWidth / 28) * Math.ceil(candidateHeight / 28);
  const fits = (candidateWidth: number, candidateHeight: number) =>
    Math.ceil(candidateWidth / 28) * 28 <= maxEdge &&
    Math.ceil(candidateHeight / 28) * 28 <= maxEdge &&
    countTokens(candidateWidth, candidateHeight) <= maxTokens;

  const resizedSize = (
    candidateWidth: number,
    candidateHeight: number
  ): { width: number; height: number } => {
    if (fits(candidateWidth, candidateHeight)) {
      return { width: candidateWidth, height: candidateHeight };
    }
    if (candidateHeight > candidateWidth) {
      const transposed = resizedSize(candidateHeight, candidateWidth);
      return { width: transposed.height, height: transposed.width };
    }

    const aspectRatio = candidateWidth / candidateHeight;
    let low = 1;
    let high = candidateWidth;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      const scaledHeight = Math.max(1, Math.round(middle / aspectRatio));
      if (fits(middle, scaledHeight)) {
        low = middle;
      } else {
        high = middle;
      }
    }
    return {
      width: low,
      height: Math.max(1, Math.round(low / aspectRatio)),
    };
  };

  const resized = resizedSize(width, height);
  return countTokens(resized.width, resized.height);
};

const estimateGeminiTokens = (width: number, height: number): number => {
  if (width <= 384 && height <= 384) return 258;
  const cropUnit = Math.max(1, Math.floor(Math.min(width, height) / 1.5));
  const tiles = Math.ceil(width / cropUnit) * Math.ceil(height / cropUnit);
  return tiles * 258;
};

export const estimateImageContextTokens = (params: {
  metadata?: ImageContextMetadata;
  detail?: ImageDetail;
  context?: MultimodalTokenContext;
}): ImageTokenEstimate => {
  const width = normalizeDimension(params.metadata?.width);
  const height = normalizeDimension(params.metadata?.height);
  if (!width || !height) {
    return {
      tokens: 0,
      source: 'unknown_dimensions',
      confidence: 'unknown',
      hasKnownDimensions: false,
    };
  }

  const context = params.context ?? {};
  const fingerprint = normalizedProviderFingerprint(context);
  const modelId = normalizedModelId(context);
  const detail = params.detail ?? params.metadata?.detail ?? 'auto';
  const isAnthropic = fingerprint.includes('anthropic') || modelId.includes('claude');
  const isGemini = fingerprint.includes('gemini') || modelId.includes('gemini');
  const patchProfile = resolveOpenAiPatchProfile(modelId, detail);
  const tileProfile = resolveOpenAiTileProfile(modelId);

  if (patchProfile) {
    return {
      tokens: estimatePatchTokens(width, height, patchProfile),
      source: 'openai_patch',
      confidence: patchProfile.confidence,
      hasKnownDimensions: true,
    };
  }
  if (tileProfile) {
    return {
      tokens: estimateTileTokens(width, height, detail, tileProfile),
      source: 'openai_tile',
      confidence: tileProfile.confidence,
      hasKnownDimensions: true,
    };
  }
  if (isAnthropic) {
    return {
      tokens: estimateAnthropicTokens(width, height, modelId),
      source: 'anthropic_patches',
      confidence: 'provider_formula',
      hasKnownDimensions: true,
    };
  }
  if (isGemini) {
    return {
      tokens: estimateGeminiTokens(width, height),
      source: 'gemini_tiles',
      confidence: 'provider_formula',
      hasKnownDimensions: true,
    };
  }

  return {
    tokens: estimatePatchTokens(width, height, {
      maxDimension: 2048,
      patchBudget: 2500,
      multiplier: 1,
      confidence: 'fallback',
    }),
    source: 'dimension_fallback',
    confidence: 'fallback',
    hasKnownDimensions: true,
  };
};

const estimateDataUrlBytes = (value: string): number => {
  const match = value.trim().match(/^data:[^;,]+(?:;[^,]*)?;base64,([\s\S]*)$/i);
  if (!match?.[1]) return 0;
  const encoded = match[1].replace(/\s+/g, '');
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
};

const estimateRawBase64Bytes = (value: string): number => {
  const encoded = value.replace(/\s+/g, '');
  if (!encoded || !/^[a-z0-9+/]+={0,2}$/i.test(encoded)) return 0;
  const padding = encoded.endsWith('==') ? 2 : encoded.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((encoded.length * 3) / 4) - padding);
};

const isImageDataUrl = (value: string): boolean =>
  /^data:image\/[^;,]+(?:;[^,]*)?,/i.test(value.trim());

export const fingerprintImageSource = (value: string): string => {
  const trimmed = value.trim();
  const dataUrlComma = isImageDataUrl(trimmed) ? trimmed.indexOf(',') : -1;
  const rawBase64 =
    dataUrlComma >= 0 ||
    (trimmed.length >= 32 && !trimmed.includes(':') && /^[a-z0-9+/=\s]+$/i.test(trimmed));
  const start = dataUrlComma >= 0 ? dataUrlComma + 1 : 0;
  let hash = 2_166_136_261;
  let length = 0;
  for (let index = start; index < trimmed.length; index += 1) {
    const code = trimmed.charCodeAt(index);
    if (rawBase64 && (code === 9 || code === 10 || code === 13 || code === 32)) {
      continue;
    }
    hash ^= code;
    hash = Math.imul(hash, 16_777_619);
    length += 1;
  }
  return `${rawBase64 ? 'base64' : 'reference'}:${length}:${(hash >>> 0).toString(16)}`;
};

export const estimateTextTokens = (value: string): number => {
  const normalized = value.trim();
  if (!normalized) return 0;
  return Math.max(1, Math.ceil(normalized.length / CHARS_PER_TOKEN));
};

const nextImageEstimate = (
  state: SanitizeState,
  detail?: ImageDetail,
  source?: string
): ImageTokenEstimate => {
  const sourceFingerprint = source ? fingerprintImageSource(source) : undefined;
  let metadataIndex = sourceFingerprint
    ? state.imageMetadata.findIndex(
        (metadata, index) =>
          !state.usedImageMetadataIndexes.has(index) &&
          metadata.sourceFingerprint === sourceFingerprint
      )
    : -1;
  if (metadataIndex < 0) {
    metadataIndex = state.imageMetadata.findIndex(
      (metadata, index) =>
        !state.usedImageMetadataIndexes.has(index) &&
        (!sourceFingerprint || !metadata.sourceFingerprint)
    );
  }
  const metadata = metadataIndex >= 0 ? state.imageMetadata[metadataIndex] : undefined;
  if (metadataIndex >= 0) state.usedImageMetadataIndexes.add(metadataIndex);
  return estimateImageContextTokens({ metadata, detail, context: state.context });
};

const findNativeImageSource = (
  value: unknown,
  seen = new WeakSet<object>()
): string | undefined => {
  if (typeof value === 'string') return isImageDataUrl(value) ? value : undefined;
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const child of value) {
      const source = findNativeImageSource(child, seen);
      if (source) return source;
    }
    return undefined;
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase().replace(/_/g, '');
    if (
      typeof child === 'string' &&
      (normalizedKey === 'data' ||
        normalizedKey === 'url' ||
        normalizedKey === 'imageurl' ||
        normalizedKey === 'fileid')
    ) {
      return child;
    }
    const source = findNativeImageSource(child, seen);
    if (source) return source;
  }
  return undefined;
};

const isNativeImageContainer = (
  value: Record<string, unknown>,
  recordType: string
): boolean => {
  if (IMAGE_CONTAINER_TYPES.has(recordType)) return true;
  return Object.entries(value).some(([key, child]) => {
    const normalizedKey = key.toLowerCase().replace(/_/g, '');
    if (normalizedKey !== 'inlinedata' || !isRecord(child)) return false;
    const mimeType = child.mimeType ?? child.mime_type;
    return typeof mimeType === 'string' && mimeType.startsWith('image/');
  });
};

const sanitizeNativeImageContainer = (
  value: unknown,
  key: string | null = null,
  seen = new WeakSet<object>()
): { value: unknown; imageTransportBytes: number } => {
  if (typeof value === 'string') {
    const normalizedKey = key?.toLowerCase().replace(/_/g, '') ?? '';
    const isReference =
      normalizedKey === 'data' ||
      normalizedKey === 'url' ||
      normalizedKey === 'imageurl' ||
      normalizedKey === 'fileid';
    if (!isReference && !isImageDataUrl(value)) {
      return { value, imageTransportBytes: 0 };
    }
    const imageTransportBytes =
      estimateDataUrlBytes(value) ||
      (normalizedKey === 'data' ? estimateRawBase64Bytes(value) : 0);
    return { value: '[image attachment]', imageTransportBytes };
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return { value: '[circular reference]', imageTransportBytes: 0 };
    }
    seen.add(value);
    let imageTransportBytes = 0;
    const sanitized = value.map((child) => {
      const result = sanitizeNativeImageContainer(child, null, seen);
      imageTransportBytes += result.imageTransportBytes;
      return result.value;
    });
    return { value: sanitized, imageTransportBytes };
  }
  if (!isRecord(value)) {
    return { value, imageTransportBytes: 0 };
  }
  if (seen.has(value)) {
    return { value: '[circular reference]', imageTransportBytes: 0 };
  }
  seen.add(value);
  let imageTransportBytes = 0;
  const sanitized = Object.fromEntries(
    Object.entries(value).map(([childKey, child]) => {
      const result = sanitizeNativeImageContainer(child, childKey, seen);
      imageTransportBytes += result.imageTransportBytes;
      return [childKey, result.value];
    })
  );
  return { value: sanitized, imageTransportBytes };
};

const sanitizeImageReference = (
  value: unknown,
  state: SanitizeState,
  containerDetail?: ImageDetail
): SanitizedTokenValue => {
  if (typeof value === 'string') {
    return {
      value: '[image attachment]',
      imageEstimates: [nextImageEstimate(state, containerDetail, value)],
      imageTransportBytes: estimateDataUrlBytes(value),
    };
  }

  if (isRecord(value) && typeof value.url === 'string') {
    return {
      value: { ...value, url: '[image attachment]' },
      imageEstimates: [
        nextImageEstimate(
          state,
          normalizeDetail(value.detail) ?? containerDetail,
          value.url
        ),
      ],
      imageTransportBytes: estimateDataUrlBytes(value.url),
    };
  }

  return sanitizeImagesForTokenEstimation(value, state);
};

const sanitizeImagesForTokenEstimation = (
  value: unknown,
  state: SanitizeState
): SanitizedTokenValue => {
  if (typeof value === 'string') {
    if (!isImageDataUrl(value)) {
      return { value, imageEstimates: [], imageTransportBytes: 0 };
    }
    return {
      value: '[image attachment]',
      imageEstimates: [nextImageEstimate(state, undefined, value)],
      imageTransportBytes: estimateDataUrlBytes(value),
    };
  }

  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      return { value: '[circular reference]', imageEstimates: [], imageTransportBytes: 0 };
    }
    state.seen.add(value);
    const imageEstimates: ImageTokenEstimate[] = [];
    let imageTransportBytes = 0;
    const sanitized = value.map((item) => {
      const result = sanitizeImagesForTokenEstimation(item, state);
      imageEstimates.push(...result.imageEstimates);
      imageTransportBytes += result.imageTransportBytes;
      return result.value;
    });
    return { value: sanitized, imageEstimates, imageTransportBytes };
  }

  if (!isRecord(value)) {
    return { value, imageEstimates: [], imageTransportBytes: 0 };
  }
  if (state.seen.has(value)) {
    return { value: '[circular reference]', imageEstimates: [], imageTransportBytes: 0 };
  }
  state.seen.add(value);

  const imageEstimates: ImageTokenEstimate[] = [];
  let imageTransportBytes = 0;
  const sanitized: Record<string, unknown> = {};
  const recordType =
    typeof value.type === 'string' ? value.type.trim().toLowerCase() : '';
  if (isNativeImageContainer(value, recordType)) {
    const sanitized = sanitizeNativeImageContainer(value);
    return {
      value: sanitized.value,
      imageEstimates: [
        nextImageEstimate(
          state,
          normalizeDetail(value.detail),
          findNativeImageSource(value)
        ),
      ],
      imageTransportBytes: sanitized.imageTransportBytes,
    };
  }
  for (const [key, child] of Object.entries(value)) {
    const normalizedKey = key.toLowerCase();
    const result =
      IMAGE_REFERENCE_KEYS.has(normalizedKey) ||
      (normalizedKey === 'url' && IMAGE_CONTAINER_TYPES.has(recordType))
        ? sanitizeImageReference(child, state, normalizeDetail(value.detail))
        : sanitizeImagesForTokenEstimation(child, state);
    sanitized[key] = result.value;
    imageEstimates.push(...result.imageEstimates);
    imageTransportBytes += result.imageTransportBytes;
  }
  return { value: sanitized, imageEstimates, imageTransportBytes };
};

const combineImageConfidence = (
  estimates: ImageTokenEstimate[]
): ImageTokenEstimateConfidence => {
  if (estimates.some((estimate) => estimate.confidence === 'unknown')) return 'unknown';
  if (estimates.some((estimate) => estimate.confidence === 'fallback')) return 'fallback';
  if (estimates.some((estimate) => estimate.confidence === 'provider_formula')) {
    return 'provider_formula';
  }
  return estimates.length > 0 ? 'model_formula' : 'unknown';
};

export const estimateStructuredContext = (
  value: unknown,
  options: {
    imageMetadata?: ImageContextMetadata[];
    context?: MultimodalTokenContext;
  } = {}
): StructuredContextTokenEstimate => {
  const sanitized = sanitizeImagesForTokenEstimation(value, {
    seen: new WeakSet<object>(),
    imageMetadata: options.imageMetadata ?? [],
    usedImageMetadataIndexes: new Set<number>(),
    context: options.context ?? {},
  });
  let serialized = '';
  try {
    serialized = JSON.stringify(sanitized.value) ?? '';
  } catch {
    // Provider inputs should be JSON. Known image costs remain usable if an
    // adapter supplies a cyclic or otherwise unserializable value.
  }
  const textTokens = estimateTextTokens(serialized);
  const imageTokens = sanitized.imageEstimates.reduce(
    (total, estimate) => total + estimate.tokens,
    0
  );
  return {
    totalTokens: textTokens + imageTokens,
    textTokens,
    imageTokens,
    imageCount: sanitized.imageEstimates.length,
    imagesWithKnownDimensions: sanitized.imageEstimates.filter(
      (estimate) => estimate.hasKnownDimensions
    ).length,
    imageTransportBytes: sanitized.imageTransportBytes,
    imageEstimateConfidence: combineImageConfidence(sanitized.imageEstimates),
    imageEstimateSources: Array.from(
      new Set(sanitized.imageEstimates.map((estimate) => estimate.source))
    ),
  };
};

export const estimateStructuredContextTokens = (
  value: unknown,
  options?: {
    imageMetadata?: ImageContextMetadata[];
    context?: MultimodalTokenContext;
  }
): number => estimateStructuredContext(value, options).totalTokens;
