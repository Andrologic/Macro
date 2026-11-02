-- Native-only attribution. A UI request cannot claim that a process ended.
CREATE TABLE engine_effect_processes (
    system_id TEXT NOT NULL,
    effect_key TEXT NOT NULL,
    process_id INTEGER NOT NULL CHECK (process_id > 0),
    PRIMARY KEY (system_id, effect_key),
    FOREIGN KEY (system_id, effect_key) REFERENCES engine_effects(system_id, effect_key)
);
CREATE TRIGGER engine_effect_process_immutable BEFORE UPDATE ON engine_effect_processes
BEGIN SELECT RAISE(ABORT, 'immutable native process attribution'); END;
