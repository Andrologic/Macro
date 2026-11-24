import type { LaunchValues } from "../agsdl/launchFields";
import { invoke } from "../tauriRuntimeBridge";
import type { LaunchConfiguration, LaunchModelOverrides, LaunchRequest } from "./architectLaunch";
import type { VersionKey } from "./architectLibrary";

export type ScheduleRepeat = { kind: "once" | "daily" | "monthly" }
  | { kind: "hourly"; hours: number }
  | { kind: "weekly"; weekdays: number[] };

export interface ScheduleTiming {
  firstAtMs: number;
  repeat: ScheduleRepeat;
}

export interface SchedulePolicy {
  catchUp: boolean;
  allowOverlap: boolean;
  alwaysLatest: boolean;
}

export interface ScheduledLaunch {
  id: string;
  version: VersionKey;
  systemLabel: string;
  latestNumber: number;
  nextAtMs: number | null;
  suspended: boolean;
  starting: boolean;
  issueCode: string | null;
  issueAtMs: number | null;
  configuration: LaunchConfiguration;
  startMessage: string | null;
  launchValues?: LaunchValues | null;
  modelOverrides: LaunchModelOverrides;
  policy: SchedulePolicy;
}

export type ScheduleAction = { kind: "suspend" | "resume" | "delete" } | { kind: "dismiss"; atMs: number };

export const architectSchedule = {
  list: () => invoke<ScheduledLaunch[]>("architect_schedule_list"),
  save: (request: { id: string | null; launch: LaunchRequest; timing: ScheduleTiming | null; policy: SchedulePolicy }) =>
    invoke<string>("architect_schedule_save", { request }),
  act: (id: string, action: ScheduleAction) => invoke<void>("architect_schedule_action", { id, action }),
};
