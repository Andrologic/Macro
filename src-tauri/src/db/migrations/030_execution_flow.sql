-- Durable 0.3 flow state; the native owner and dispatch are admitted separately.
CREATE TABLE engine_flow030_runs (
    system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL, epoch TEXT NOT NULL,
    source_json TEXT NOT NULL CHECK(json_valid(source_json)),
    plan_json TEXT NOT NULL CHECK(json_valid(plan_json)),
    state_json TEXT NOT NULL CHECK(json_valid(state_json)),
    PRIMARY KEY(system_id, invocation_id),
    UNIQUE(system_id, invocation_id, snapshot_id, epoch)
);
CREATE TRIGGER engine_flow030_capture_immutable
BEFORE UPDATE OF system_id, invocation_id, snapshot_id, epoch, source_json, plan_json ON engine_flow030_runs
BEGIN SELECT RAISE(ABORT, 'immutable flow capture'); END;
CREATE TABLE engine_flow030_events (
    system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    event_id TEXT NOT NULL, event_json TEXT NOT NULL CHECK(json_valid(event_json)),
    receipt_json TEXT CHECK(receipt_json IS NULL OR json_valid(receipt_json)),
    diagnostic_json TEXT CHECK(diagnostic_json IS NULL OR json_valid(diagnostic_json)),
    PRIMARY KEY(system_id, invocation_id, event_id),
    FOREIGN KEY(system_id, invocation_id) REFERENCES engine_flow030_runs(system_id, invocation_id),
    CHECK((receipt_json IS NULL) <> (diagnostic_json IS NULL))
);
CREATE TABLE engine_flow030_outbox (
    system_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
    effect_id TEXT NOT NULL, event_id TEXT NOT NULL,
    effect_json TEXT NOT NULL CHECK(json_valid(effect_json)), owner_epoch TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','uncertain','settled','revoked')),
    settlement_json TEXT CHECK(settlement_json IS NULL OR json_valid(settlement_json)),
    PRIMARY KEY(system_id, invocation_id, effect_id),
    FOREIGN KEY(system_id, invocation_id, event_id) REFERENCES engine_flow030_events(system_id, invocation_id, event_id),
    CHECK((status = 'settled') = (settlement_json IS NOT NULL))
);
CREATE INDEX engine_flow030_outbox_pending ON engine_flow030_outbox(system_id, invocation_id, status);
CREATE TABLE engine_start030_requests (
    request_id TEXT PRIMARY KEY NOT NULL,
    request_json TEXT NOT NULL CHECK(json_valid(request_json)),
    system_id TEXT NOT NULL UNIQUE, invocation_id TEXT NOT NULL,
    snapshot_id TEXT NOT NULL, capture_epoch TEXT NOT NULL,
    capture_json TEXT NOT NULL CHECK(json_valid(capture_json)),
    receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
    UNIQUE(system_id, invocation_id),
    FOREIGN KEY(system_id, invocation_id, snapshot_id, capture_epoch)
        REFERENCES engine_flow030_runs(system_id, invocation_id, snapshot_id, epoch)
);
CREATE TRIGGER engine_start030_immutable BEFORE UPDATE ON engine_start030_requests
BEGIN SELECT RAISE(ABORT, 'immutable start capture'); END;
CREATE TRIGGER engine_start020_reject_030 BEFORE INSERT ON engine_systems
WHEN EXISTS(SELECT 1 FROM engine_start030_requests WHERE request_id=NEW.request_id OR system_id=NEW.system_id)
BEGIN SELECT RAISE(ABORT, 'execution request identity conflict'); END;
CREATE TRIGGER engine_start030_reject_020 BEFORE INSERT ON engine_start030_requests
WHEN EXISTS(SELECT 1 FROM engine_systems WHERE request_id=NEW.request_id OR system_id=NEW.system_id)
BEGIN SELECT RAISE(ABORT, 'execution request identity conflict'); END;
