CREATE TABLE engine_systems (
    system_id TEXT PRIMARY KEY NOT NULL,
    request_id TEXT UNIQUE NOT NULL,
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    snapshot_json TEXT NOT NULL CHECK (json_valid(snapshot_json)),
    policies_json TEXT NOT NULL CHECK (json_valid(policies_json)),
    state_json TEXT NOT NULL CHECK (json_valid(state_json))
);
CREATE TRIGGER engine_snapshot_immutable BEFORE UPDATE OF system_id, request_id, request_json, snapshot_json, policies_json ON engine_systems
BEGIN SELECT RAISE(ABORT, 'immutable execution snapshot'); END;
CREATE TABLE engine_deliveries (
    delivery_id TEXT PRIMARY KEY NOT NULL,
    activation_id TEXT UNIQUE NOT NULL,
    system_id TEXT NOT NULL REFERENCES engine_systems(system_id),
    receipt_json TEXT NOT NULL CHECK (json_valid(receipt_json))
);
CREATE TABLE engine_effects (
    system_id TEXT NOT NULL REFERENCES engine_systems(system_id),
    activation_id TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    record_json TEXT NOT NULL CHECK (json_valid(record_json)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'ended', 'uncertain')),
    settlement_json TEXT CHECK (settlement_json IS NULL OR json_valid(settlement_json)),
    result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json)),
    PRIMARY KEY (system_id, effect_key),
    CHECK (status <> 'ended' OR settlement_json IS NOT NULL),
    CHECK (result_json IS NULL OR status = 'ended')
);
CREATE INDEX engine_effect_activation ON engine_effects(system_id, activation_id, status);
CREATE TABLE engine_events (
    system_id TEXT NOT NULL REFERENCES engine_systems(system_id),
    sequence TEXT NOT NULL CHECK (sequence <> '' AND sequence NOT GLOB '*[^0-9]*' AND (sequence = '0' OR substr(sequence,1,1) <> '0')),
    event_json TEXT NOT NULL CHECK (json_valid(event_json)),
    PRIMARY KEY (system_id, sequence)
);
