-- Private native continuity is retained before a terminal checkpoint exists.
CREATE TABLE engine_native_operations (
 system_id TEXT NOT NULL REFERENCES engine_systems(system_id),
 activation_id TEXT NOT NULL,
 effect_key TEXT NOT NULL,
 operation_id TEXT NOT NULL,
 agent_instance_id TEXT NOT NULL,
 context_json TEXT NOT NULL CHECK(json_valid(context_json)),
 adapter TEXT NOT NULL,
 version TEXT NOT NULL,
 profile_digest TEXT NOT NULL,
 method TEXT NOT NULL,
 request_json TEXT NOT NULL CHECK(json_valid(request_json)),
 state TEXT NOT NULL CHECK(state IN ('possiblySent','received')),
 references_json TEXT CHECK(references_json IS NULL OR json_valid(references_json)),
 PRIMARY KEY(system_id,operation_id)
);
CREATE INDEX engine_native_instance ON engine_native_operations(system_id,agent_instance_id);
