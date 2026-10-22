CREATE TABLE engine_responses (
 system_id TEXT NOT NULL REFERENCES engine_systems(system_id), activation_id TEXT NOT NULL,
 sequence TEXT NOT NULL, identity TEXT NOT NULL, payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
 PRIMARY KEY(system_id,activation_id,sequence), UNIQUE(system_id,activation_id,identity)
);
CREATE TABLE engine_response_closures (
 system_id TEXT NOT NULL REFERENCES engine_systems(system_id), activation_id TEXT NOT NULL,
 receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)), PRIMARY KEY(system_id,activation_id)
);
CREATE TABLE engine_host_captures (
 system_id TEXT PRIMARY KEY NOT NULL REFERENCES engine_systems(system_id),
 registry_json TEXT NOT NULL CHECK(json_valid(registry_json))
);
CREATE TRIGGER engine_host_capture_immutable BEFORE UPDATE ON engine_host_captures
BEGIN SELECT RAISE(ABORT, 'immutable execution registry'); END;

CREATE TABLE engine_approvals (
 approval_id TEXT PRIMARY KEY NOT NULL,
 system_id TEXT NOT NULL REFERENCES engine_systems(system_id), activation_id TEXT NOT NULL,
 effect_key TEXT NOT NULL, request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 status TEXT NOT NULL CHECK(status IN ('pending','approved','denied','consumed','cancelled')),
 UNIQUE(system_id,effect_key)
);

CREATE TABLE engine_prepared_terminals (
 system_id TEXT NOT NULL REFERENCES engine_systems(system_id), activation_id TEXT NOT NULL,
 witness_id TEXT NOT NULL UNIQUE, witness_json TEXT NOT NULL CHECK(json_valid(witness_json)),
 PRIMARY KEY(system_id,activation_id)
);
