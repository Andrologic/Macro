CREATE TABLE architect_legacy_import (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    discovered INTEGER NOT NULL CHECK (discovered >= 0),
    divergent_plans INTEGER NOT NULL CHECK (divergent_plans BETWEEN 0 AND discovered)
);

UPDATE architect_blueprints
SET history = json_set(coalesce(history, '{}'), '$.legacyConversationId', conversation_id)
WHERE source_id IS NOT NULL AND conversation_id IS NOT NULL
  AND json_type(history, '$.legacyConversationId') IS NULL;
