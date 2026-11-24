CREATE TABLE operate_inbox_runs (
    system_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    started_at_ms INTEGER,
    finished_at_ms INTEGER,
    opened INTEGER NOT NULL DEFAULT 0 CHECK(opened IN (0,1)),
    PRIMARY KEY(system_id, invocation_id),
    FOREIGN KEY(system_id, invocation_id) REFERENCES engine_flow030_runs(system_id, invocation_id) ON DELETE CASCADE
);
CREATE TABLE operate_inbox_threads (
    system_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    activity INTEGER NOT NULL DEFAULT 0,
    activity_at_ms INTEGER,
    snoozed_at_activity INTEGER,
    snooze_until_ms INTEGER,
    snoozed_for_request INTEGER NOT NULL DEFAULT 0 CHECK(snoozed_for_request IN (0,1)),
    PRIMARY KEY(system_id, invocation_id, instance_id),
    FOREIGN KEY(system_id, invocation_id) REFERENCES operate_inbox_runs(system_id, invocation_id) ON DELETE CASCADE,
    CHECK((snooze_until_ms IS NULL) = (snoozed_at_activity IS NULL))
);
-- Older journals have no wall-clock start or completion timestamps.
INSERT INTO operate_inbox_runs(system_id, invocation_id)
SELECT system_id, invocation_id FROM engine_flow030_runs;

CREATE TRIGGER macro_operate_run_started AFTER INSERT ON engine_flow030_runs
BEGIN
    INSERT INTO operate_inbox_runs(system_id, invocation_id, started_at_ms)
    VALUES(NEW.system_id, NEW.invocation_id, CAST(unixepoch('subsec') * 1000 AS INTEGER));
END;

CREATE TRIGGER macro_operate_flow_activity AFTER UPDATE OF state_json ON engine_flow030_runs
BEGIN
    UPDATE operate_inbox_runs SET finished_at_ms = CAST(unixepoch('subsec') * 1000 AS INTEGER)
    WHERE system_id = NEW.system_id AND invocation_id = NEW.invocation_id AND finished_at_ms IS NULL
      AND json_extract(NEW.state_json, '$.verdict') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM json_each(NEW.state_json, '$.activations') WHERE value ->> '$.physical' = 1)
      AND (json_extract(OLD.state_json, '$.verdict') IS NULL
           OR EXISTS(SELECT 1 FROM json_each(OLD.state_json, '$.activations') WHERE value ->> '$.physical' = 1));

    -- Activations are retained in journal order. Updating another instance does not wake this one.
    INSERT INTO operate_inbox_threads(system_id, invocation_id, instance_id, activity, activity_at_ms)
    SELECT DISTINCT NEW.system_id, NEW.invocation_id, a.value ->> '$.instanceId', 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM json_each(NEW.state_json, '$.activations') a
    WHERE a.value ->> '$.instanceId' IS NOT NULL
      AND a.value IS NOT (OLD.state_json -> ('$.activations[' || a.key || ']'))
    ON CONFLICT(system_id, invocation_id, instance_id) DO UPDATE SET
        activity = activity + 1, activity_at_ms = excluded.activity_at_ms;
END;

CREATE TRIGGER macro_operate_human_opened AFTER INSERT ON engine_flow030_human_requests
BEGIN
    INSERT INTO operate_inbox_threads(system_id, invocation_id, instance_id, activity, activity_at_ms)
    SELECT DISTINCT NEW.system_id, NEW.invocation_id, a.value ->> '$.instanceId', 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM engine_flow030_runs r, json_each(r.state_json, '$.activations') a
    WHERE r.system_id = NEW.system_id AND r.invocation_id = NEW.invocation_id
      AND a.value ->> '$.instanceId' IS NOT NULL
      AND a.value ->> '$.id' IN (SELECT value FROM json_each(NEW.work_ids_json))
    ON CONFLICT(system_id, invocation_id, instance_id) DO UPDATE SET
        activity = activity + 1, activity_at_ms = excluded.activity_at_ms;
END;

CREATE TRIGGER macro_operate_human_changed AFTER UPDATE OF revision, work_ids_json ON engine_flow030_human_requests
BEGIN
    INSERT INTO operate_inbox_threads(system_id, invocation_id, instance_id, activity, activity_at_ms)
    SELECT DISTINCT NEW.system_id, NEW.invocation_id, a.value ->> '$.instanceId', 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM engine_flow030_runs r, json_each(r.state_json, '$.activations') a
    WHERE r.system_id = NEW.system_id AND r.invocation_id = NEW.invocation_id
      AND a.value ->> '$.instanceId' IS NOT NULL
      AND a.value ->> '$.id' IN (SELECT value FROM (SELECT value FROM json_each(NEW.work_ids_json) UNION SELECT value FROM json_each(OLD.work_ids_json)))
    ON CONFLICT(system_id, invocation_id, instance_id) DO UPDATE SET
        activity = activity + 1, activity_at_ms = excluded.activity_at_ms;
END;

CREATE TRIGGER macro_operate_work_progress AFTER UPDATE OF revision ON engine_flow030_work_state
WHEN NEW.revision <> OLD.revision
BEGIN
    INSERT INTO operate_inbox_threads(system_id, invocation_id, instance_id, activity, activity_at_ms)
    SELECT NEW.system_id, NEW.invocation_id, a.value ->> '$.instanceId', 1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM engine_flow030_runs r, json_each(r.state_json, '$.activations') a
    WHERE r.system_id = NEW.system_id AND r.invocation_id = NEW.invocation_id
      AND a.value ->> '$.instanceId' IS NOT NULL AND a.value ->> '$.id' = NEW.activation_id
    ON CONFLICT(system_id, invocation_id, instance_id) DO UPDATE SET
        activity = activity + 1, activity_at_ms = excluded.activity_at_ms;
END;
