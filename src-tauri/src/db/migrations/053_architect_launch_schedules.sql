CREATE TABLE architect_launch_schedules (
    id TEXT PRIMARY KEY NOT NULL,
    blueprint_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    settings_json TEXT NOT NULL CHECK (json_type(settings_json) = 'object'),
    timing_json TEXT NOT NULL CHECK (json_type(timing_json) = 'object'),
    next_at_ms INTEGER,
    suspended INTEGER NOT NULL DEFAULT 0 CHECK (suspended IN (0, 1)),
    inflight_at_ms INTEGER,
    resumed_at_ms INTEGER,
    issue_code TEXT,
    issue_at_ms INTEGER,
    FOREIGN KEY (blueprint_id, number) REFERENCES architect_versions(blueprint_id, number) ON DELETE RESTRICT
);
CREATE INDEX architect_launch_schedule_due ON architect_launch_schedules(next_at_ms)
    WHERE suspended = 0 AND inflight_at_ms IS NULL;

CREATE TABLE architect_launch_schedule_runs (
    system_id TEXT PRIMARY KEY NOT NULL REFERENCES architect_launch_runs(system_id) ON DELETE CASCADE,
    schedule_id TEXT NOT NULL REFERENCES architect_launch_schedules(id) ON DELETE CASCADE,
    due_at_ms INTEGER NOT NULL,
    UNIQUE (schedule_id, due_at_ms)
);
