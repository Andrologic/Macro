ALTER TABLE tool_invocations ADD COLUMN result_json TEXT CHECK (result_json IS NULL OR json_valid(result_json));
CREATE TRIGGER tool_result_requires_completion_insert BEFORE INSERT ON tool_invocations
WHEN NEW.result_json IS NOT NULL AND NEW.status <> 'completed'
BEGIN SELECT RAISE(ABORT, 'result requires completion'); END;
CREATE TRIGGER tool_result_requires_completion_update BEFORE UPDATE ON tool_invocations
WHEN NEW.result_json IS NOT NULL AND NEW.status <> 'completed'
BEGIN SELECT RAISE(ABORT, 'result requires completion'); END;
