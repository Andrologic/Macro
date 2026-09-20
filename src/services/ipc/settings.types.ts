import type {
AppSettingRecord as NativeDbAppSetting,
CompareAndSwapAppSettingResult as NativeDbCompareAndSwapAppSettingResult,
ProjectContextStateRecord as NativeDbProjectContextState,
ProjectRegistryDbRepairReport as NativeDbProjectRegistryRepairReport,
SessionContextStateRecord as NativeDbSessionContextState
} from '../../types/generated/ipc';

/** settings IPC contracts and explicit frontend adaptations of generated native bindings. */

export type DbAppSetting = NativeDbAppSetting;

export type DbCompareAndSwapAppSettingResult = NativeDbCompareAndSwapAppSettingResult;

export type DbProjectContextState = NativeDbProjectContextState;

export type DbSessionContextState = NativeDbSessionContextState;

export type DbProjectRegistryRepairReport = NativeDbProjectRegistryRepairReport;
