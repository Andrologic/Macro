import { loadPreference, PREF_KEYS, savePreference } from './preferences';

export const UPDATE_CHANNELS = ['stable', 'preview'] as const;

export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];

export const DEFAULT_UPDATE_CHANNEL: UpdateChannel = 'stable';

export const normalizeUpdateChannel = (value: unknown): UpdateChannel =>
  value === 'preview' ? 'preview' : DEFAULT_UPDATE_CHANNEL;

export const loadUpdateChannel = async (): Promise<UpdateChannel> =>
  normalizeUpdateChannel(await loadPreference(PREF_KEYS.UPDATE_CHANNEL));

export const saveUpdateChannel = async (channel: UpdateChannel): Promise<void> =>
  savePreference(PREF_KEYS.UPDATE_CHANNEL, channel);

export const updaterTargetForChannel = (
  channel: UpdateChannel,
  nativeTarget: string,
): string => `${channel}-${nativeTarget}`;

export const shouldAllowChannelDowngrade = (
  channel: UpdateChannel,
  currentVersion: string,
): boolean => channel === 'stable' && currentVersion.includes('-');
