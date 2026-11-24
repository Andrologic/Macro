CREATE TABLE architect_projects (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    source_project_id TEXT UNIQUE
);
CREATE TABLE architect_blueprints (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES architect_projects(id),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    document TEXT NOT NULL CHECK (json_valid(document)),
    source_id TEXT,
    conversation_id TEXT CHECK (conversation_id IS NULL OR length(trim(conversation_id)) > 0),
    history TEXT CHECK (history IS NULL OR json_type(history) = 'object'),
    archived INTEGER GENERATED ALWAYS AS (coalesce(json_extract(history, '$.status') = 'archived', 0)) STORED,
    origin_blueprint_id TEXT,
    origin_number INTEGER,
    CHECK ((origin_blueprint_id IS NULL) = (origin_number IS NULL)),
    UNIQUE (project_id, source_id)
);
CREATE TABLE architect_versions (
    blueprint_id TEXT NOT NULL REFERENCES architect_blueprints(id),
    number INTEGER NOT NULL CHECK (number > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    note TEXT,
    document TEXT NOT NULL CHECK (json_valid(document)),
    PRIMARY KEY (blueprint_id, number)
);
CREATE TRIGGER architect_version_immutable BEFORE UPDATE ON architect_versions
BEGIN
    SELECT RAISE(ABORT, 'immutable_version');
END;
CREATE TABLE architect_version_uses (
    kind TEXT NOT NULL CHECK (kind IN ('execution', 'schedule')),
    owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
    blueprint_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (kind, owner_id),
    FOREIGN KEY (blueprint_id, number) REFERENCES architect_versions(blueprint_id, number) ON DELETE RESTRICT
);
CREATE INDEX architect_version_use_lookup ON architect_version_uses(blueprint_id, number);
