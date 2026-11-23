CREATE TABLE architect_launch_configurations (
    blueprint_id TEXT PRIMARY KEY NOT NULL REFERENCES architect_blueprints(id),
    configuration_json TEXT NOT NULL CHECK (json_type(configuration_json) = 'object')
);
CREATE TABLE architect_launch_consents (
    blueprint_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    machine_id TEXT NOT NULL,
    permissions_json TEXT NOT NULL CHECK (json_type(permissions_json) = 'object'),
    PRIMARY KEY (blueprint_id, number, machine_id),
    FOREIGN KEY (blueprint_id, number) REFERENCES architect_versions(blueprint_id, number) ON DELETE CASCADE
);
CREATE TABLE architect_launch_runs (
    system_id TEXT PRIMARY KEY NOT NULL
        REFERENCES engine_start030_requests(system_id) DEFERRABLE INITIALLY DEFERRED,
    blueprint_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    retained_snapshot_id TEXT NOT NULL CHECK (length(retained_snapshot_id) = 64),
    run_name TEXT,
    working_folder TEXT NOT NULL,
    owns_working_folder INTEGER NOT NULL CHECK (owns_working_folder IN (0, 1)),
    configuration_json TEXT NOT NULL CHECK (json_type(configuration_json) = 'object'),
    FOREIGN KEY (blueprint_id, number) REFERENCES architect_versions(blueprint_id, number) ON DELETE RESTRICT
);
CREATE INDEX architect_launch_runs_by_blueprint ON architect_launch_runs(blueprint_id, number);
CREATE INDEX architect_launch_runs_by_snapshot ON architect_launch_runs(retained_snapshot_id);
CREATE INDEX architect_launch_runs_by_folder ON architect_launch_runs(working_folder);
