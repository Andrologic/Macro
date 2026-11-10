CREATE TABLE engine_flow030_interruptions (
    system_id TEXT PRIMARY KEY NOT NULL,
    interrupted_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY(system_id) REFERENCES engine_flow030_owners(system_id)
);
