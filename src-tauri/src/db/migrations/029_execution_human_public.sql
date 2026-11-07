-- Public projections are installed only by a trusted native producer.
CREATE TABLE engine_human_public030 (
    system_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    public_id TEXT NOT NULL UNIQUE,
    content_json TEXT NOT NULL CHECK (json_valid(content_json)),
    PRIMARY KEY (system_id, request_id),
    FOREIGN KEY (system_id, request_id) REFERENCES engine_human_requests030(system_id, request_id) ON DELETE CASCADE
);
CREATE TABLE engine_human_public_works030 (
    system_id TEXT NOT NULL,
    activation_id TEXT NOT NULL,
    public_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (system_id, activation_id),
    FOREIGN KEY (system_id, activation_id) REFERENCES engine_work_protocol030(system_id, activation_id) ON DELETE CASCADE
);
-- A submission is an intent, not a controller resolution or a clock receipt.
CREATE TABLE engine_human_submissions030 (
    system_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    answer_json TEXT NOT NULL CHECK (json_valid(answer_json)),
    PRIMARY KEY (system_id, request_id),
    FOREIGN KEY (system_id, request_id) REFERENCES engine_human_public030(system_id, request_id) ON DELETE CASCADE
);
CREATE TABLE engine_human_projection030 (
    system_id TEXT PRIMARY KEY REFERENCES engine_systems(system_id) ON DELETE CASCADE,
    cursor TEXT NOT NULL
);

CREATE TRIGGER engine_human_requests030_projection_insert AFTER INSERT ON engine_human_requests030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_requests030_projection_update AFTER UPDATE ON engine_human_requests030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_requests030_projection_delete AFTER DELETE ON engine_human_requests030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT OLD.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=OLD.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_works030_projection_insert AFTER INSERT ON engine_human_works030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_works030_projection_update AFTER UPDATE ON engine_human_works030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_works030_projection_delete AFTER DELETE ON engine_human_works030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT OLD.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=OLD.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_public030_projection_insert AFTER INSERT ON engine_human_public030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_public030_projection_update AFTER UPDATE ON engine_human_public030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_public030_projection_delete AFTER DELETE ON engine_human_public030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT OLD.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=OLD.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_public_works030_projection_insert AFTER INSERT ON engine_human_public_works030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_public_works030_projection_update AFTER UPDATE ON engine_human_public_works030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_public_works030_projection_delete AFTER DELETE ON engine_human_public_works030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT OLD.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=OLD.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_submissions030_projection_insert AFTER INSERT ON engine_human_submissions030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_submissions030_projection_update AFTER UPDATE ON engine_human_submissions030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT NEW.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=NEW.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;

CREATE TRIGGER engine_human_submissions030_projection_delete AFTER DELETE ON engine_human_submissions030 BEGIN
    INSERT INTO engine_human_projection030(system_id,cursor) SELECT OLD.system_id,lower(hex(randomblob(16))) WHERE EXISTS (SELECT 1 FROM engine_systems WHERE system_id=OLD.system_id)
    ON CONFLICT(system_id) DO UPDATE SET cursor=lower(hex(randomblob(16)));
END;
