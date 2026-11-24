-- The desktop migration fills temp.architect_artifact_plan before running this
-- transaction. Keep all identities and references, including deleted numbers.
CREATE TABLE architect_blueprints_next (
    id TEXT PRIMARY KEY NOT NULL,
    project_id TEXT NOT NULL REFERENCES architect_projects(id),
    name TEXT NOT NULL CHECK (length(trim(name)) > 0),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    last_number INTEGER NOT NULL DEFAULT 0 CHECK (last_number >= 0),
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) = 36),
    storage_state TEXT NOT NULL CHECK (storage_state IN ('draft', 'recovery')),
    source_id TEXT,
    conversation_id TEXT CHECK (conversation_id IS NULL OR length(trim(conversation_id)) > 0),
    history TEXT CHECK (history IS NULL OR json_type(history) = 'object'),
    archived INTEGER GENERATED ALWAYS AS (coalesce(json_extract(history, '$.status') = 'archived', 0)) STORED,
    origin_blueprint_id TEXT,
    origin_number INTEGER,
    CHECK ((origin_blueprint_id IS NULL) = (origin_number IS NULL)),
    UNIQUE (project_id, source_id)
);
CREATE TABLE architect_versions_next (
    blueprint_id TEXT NOT NULL REFERENCES architect_blueprints_next(id),
    number INTEGER NOT NULL CHECK (number > 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    note TEXT,
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) = 36),
    storage_state TEXT NOT NULL CHECK (storage_state IN ('archive', 'recovery')),
    archive_sha256 TEXT CHECK (archive_sha256 IS NULL OR
        (length(archive_sha256) = 64 AND archive_sha256 NOT GLOB '*[^0-9a-f]*')),
    created_at TEXT,
    CHECK ((storage_state = 'archive') = (archive_sha256 IS NOT NULL)),
    PRIMARY KEY (blueprint_id, number)
);
CREATE TABLE architect_version_uses_next (
    kind TEXT NOT NULL CHECK (kind IN ('execution', 'schedule')),
    owner_id TEXT NOT NULL CHECK (length(trim(owner_id)) > 0),
    blueprint_id TEXT NOT NULL,
    number INTEGER NOT NULL,
    PRIMARY KEY (kind, owner_id),
    FOREIGN KEY (blueprint_id, number) REFERENCES architect_versions_next(blueprint_id, number) ON DELETE RESTRICT
);
INSERT INTO architect_blueprints_next
    (id,project_id,name,revision,last_number,artifact_id,storage_state,source_id,
     conversation_id,history,origin_blueprint_id,origin_number)
SELECT b.id,b.project_id,b.name,b.revision,b.last_number,p.artifact_id,p.storage_state,b.source_id,
       b.conversation_id,b.history,b.origin_blueprint_id,b.origin_number
FROM architect_blueprints b LEFT JOIN temp.architect_artifact_plan p
    ON p.blueprint_id=b.id AND p.number=0;
INSERT INTO architect_versions_next
    (blueprint_id,number,revision,note,artifact_id,storage_state,archive_sha256)
SELECT v.blueprint_id,v.number,v.revision,v.note,p.artifact_id,p.storage_state,p.archive_sha256
FROM architect_versions v LEFT JOIN temp.architect_artifact_plan p
    ON p.blueprint_id=v.blueprint_id AND p.number=v.number;
INSERT INTO architect_version_uses_next SELECT * FROM architect_version_uses;
DROP TABLE architect_version_uses;
DROP TABLE architect_versions;
DROP TABLE architect_blueprints;
ALTER TABLE architect_blueprints_next RENAME TO architect_blueprints;
ALTER TABLE architect_versions_next RENAME TO architect_versions;
ALTER TABLE architect_version_uses_next RENAME TO architect_version_uses;
CREATE INDEX architect_version_use_lookup ON architect_version_uses(blueprint_id, number);
CREATE TRIGGER architect_version_immutable BEFORE UPDATE ON architect_versions
BEGIN
    SELECT RAISE(ABORT, 'immutable_version');
END;
CREATE TABLE architect_library_originals (
    blueprint_id TEXT NOT NULL REFERENCES architect_blueprints(id),
    version_number INTEGER NOT NULL CHECK (version_number >= 0),
    revision INTEGER NOT NULL CHECK (revision > 0),
    artifact_id TEXT NOT NULL CHECK (length(artifact_id) = 36),
    PRIMARY KEY (blueprint_id, version_number, revision)
);
INSERT INTO architect_library_originals
SELECT blueprint_id,number,revision,original_id FROM temp.architect_artifact_plan;
DROP TABLE temp.architect_artifact_plan;
