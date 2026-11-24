-- The native delete command creates this authorization in the same immediate
-- transaction that removes the finished run and its journals. Deleting the run
-- consumes the authorization; rollback leaves the original guards in force.
CREATE TABLE operate_run_deletions (
    system_id TEXT PRIMARY KEY,
    invocation_id TEXT NOT NULL,
    FOREIGN KEY(system_id, invocation_id) REFERENCES engine_flow030_runs(system_id, invocation_id) ON DELETE CASCADE
);

DROP TRIGGER engine_start030_entry_retained;
CREATE TRIGGER engine_start030_entry_retained BEFORE DELETE ON engine_start030_entries
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT, 'retained start entry'); END;

DROP TRIGGER engine_flow030_no_admission_retained;
CREATE TRIGGER engine_flow030_no_admission_retained BEFORE DELETE ON engine_flow030_no_admissions
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT, 'retained native no-admission proof'); END;

DROP TRIGGER engine_flow030_handoff_retained;
CREATE TRIGGER engine_flow030_handoff_retained BEFORE DELETE ON engine_flow030_handoffs
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT, 'retained native handoff'); END;

DROP TRIGGER engine_flow030_preparation_retained;
CREATE TRIGGER engine_flow030_preparation_retained BEFORE DELETE ON engine_flow030_preparations
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT, 'retained native preparation'); END;

DROP TRIGGER engine_flow030_occurrence_provenance_retained;
CREATE TRIGGER engine_flow030_occurrence_provenance_retained BEFORE DELETE ON engine_flow030_occurrence_provenance
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT, 'retained native occurrence provenance'); END;

DROP TRIGGER engine_flow030_work_admissions_retained;
CREATE TRIGGER engine_flow030_work_admissions_retained BEFORE DELETE ON engine_flow030_work_admissions
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained work admission'); END;

DROP TRIGGER engine_flow030_work_authorizations_retained;
CREATE TRIGGER engine_flow030_work_authorizations_retained BEFORE DELETE ON engine_flow030_work_authorizations
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained work event'); END;

DROP TRIGGER engine_flow030_work_event_retained;
CREATE TRIGGER engine_flow030_work_event_retained BEFORE DELETE ON engine_flow030_work_events
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained work event'); END;

DROP TRIGGER engine_flow030_route_source_retained;
CREATE TRIGGER engine_flow030_route_source_retained BEFORE DELETE ON engine_flow030_route_source_attestations
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained native route source'); END;

DROP TRIGGER engine_flow030_route_context_retained;
CREATE TRIGGER engine_flow030_route_context_retained BEFORE DELETE ON engine_flow030_route_content_contexts
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained native content context'); END;

DROP TRIGGER engine_flow030_route_content_retained;
CREATE TRIGGER engine_flow030_route_content_retained BEFORE DELETE ON engine_flow030_route_content_receipts
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained native content receipt'); END;

DROP TRIGGER engine_flow030_system_stop_retained;
CREATE TRIGGER engine_flow030_system_stop_retained BEFORE DELETE ON engine_flow030_system_stop_requests
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained system Stop request'); END;

DROP TRIGGER engine_flow030_call_retained;
CREATE TRIGGER engine_flow030_call_retained BEFORE DELETE ON engine_flow030_calls
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained native call receipt'); END;

DROP TRIGGER engine_flow030_call_cause_retained;
CREATE TRIGGER engine_flow030_call_cause_retained BEFORE DELETE ON engine_flow030_call_causes
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=(SELECT system_id FROM engine_flow030_calls WHERE call_id=OLD.call_id))
BEGIN SELECT RAISE(ABORT,'retained native call cause'); END;

DROP TRIGGER engine_flow030_call_diagnostic_retained;
CREATE TRIGGER engine_flow030_call_diagnostic_retained BEFORE DELETE ON engine_flow030_call_diagnostics
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained native call diagnostic'); END;

DROP TRIGGER engine_flow030_clock_event_retained;
CREATE TRIGGER engine_flow030_clock_event_retained BEFORE DELETE ON engine_flow030_clock_events
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained clock journal'); END;

DROP TRIGGER engine_flow030_human_request_retained;
CREATE TRIGGER engine_flow030_human_request_retained BEFORE DELETE ON engine_flow030_human_requests
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained human request'); END;

DROP TRIGGER engine_flow030_human_submission_retained;
CREATE TRIGGER engine_flow030_human_submission_retained BEFORE DELETE ON engine_flow030_human_submissions
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained human answer'); END;

DROP TRIGGER engine_flow030_clock_cause_retained;
CREATE TRIGGER engine_flow030_clock_cause_retained BEFORE DELETE ON engine_flow030_clock_controls
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained timeout cause'); END;

DROP TRIGGER engine_flow030_handoff_clock_retained;
CREATE TRIGGER engine_flow030_handoff_clock_retained BEFORE DELETE ON engine_flow030_handoff_clock
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained handoff clock origin'); END;

DROP TRIGGER engine_flow030_human_proof_retained;
CREATE TRIGGER engine_flow030_human_proof_retained BEFORE DELETE ON engine_flow030_human_resolution_proofs
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.system_id)
BEGIN SELECT RAISE(ABORT,'retained native human resolution proof'); END;

DROP TRIGGER engine_ui_intent_retained;
CREATE TRIGGER engine_ui_intent_retained BEFORE DELETE ON engine_ui_intents
WHEN NOT EXISTS (SELECT 1 FROM operate_run_deletions WHERE system_id=OLD.admission_system030_id)
BEGIN SELECT RAISE(ABORT,'retained execution intent'); END;

-- Argentic's graceful shutdown issues a native retirement Stop to join the
-- executors. Preserve the operator state that this particular Stop clears.
CREATE TABLE operate_shutdown_holds (
    system_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    paused INTEGER NOT NULL,
    holds_json TEXT NOT NULL,
    PRIMARY KEY(system_id, invocation_id),
    FOREIGN KEY(system_id, invocation_id) REFERENCES engine_flow030_runs(system_id, invocation_id) ON DELETE CASCADE
);
CREATE TRIGGER macro_operate_shutdown_holds AFTER UPDATE OF state_json ON engine_flow030_runs
WHEN (OLD.state_json ->> '$.paused'=1 OR json_type(OLD.state_json,'$.operatorHolds')='object')
    AND EXISTS(SELECT 1 FROM engine_flow030_events e
        WHERE e.system_id=NEW.system_id AND e.invocation_id=NEW.invocation_id
          AND e.event_id GLOB 'retire:*' AND e.event_json ->> '$.kind'='Stop'
          AND e.receipt_json ->> '$.revision'=NEW.state_json ->> '$.revision')
BEGIN
    INSERT INTO operate_shutdown_holds(system_id, invocation_id, paused, holds_json)
    VALUES(NEW.system_id, NEW.invocation_id, coalesce(OLD.state_json ->> '$.paused',0),
           coalesce(OLD.state_json -> '$.operatorHolds','{}'));
END;

-- A hold changes the operator journal without necessarily changing the
-- activation row. It still counts as activity for the affected thread.
CREATE TRIGGER macro_operate_hold_activity AFTER UPDATE OF state_json ON engine_flow030_runs
WHEN (OLD.state_json -> '$.operatorHolds') IS NOT (NEW.state_json -> '$.operatorHolds')
BEGIN
    INSERT INTO operate_inbox_threads(system_id, invocation_id, instance_id, activity, activity_at_ms)
    SELECT DISTINCT NEW.system_id, NEW.invocation_id, activations.value ->> '$.instanceId',
        1, CAST(unixepoch('subsec') * 1000 AS INTEGER)
    FROM json_each(NEW.state_json, '$.activations') activations
    LEFT JOIN json_each(OLD.state_json, '$.operatorHolds') before_hold
        ON before_hold.key=activations.value ->> '$.id'
    LEFT JOIN json_each(NEW.state_json, '$.operatorHolds') after_hold
        ON after_hold.key=activations.value ->> '$.id'
    WHERE activations.value ->> '$.instanceId' IS NOT NULL AND before_hold.value IS NOT after_hold.value
    ON CONFLICT(system_id, invocation_id, instance_id) DO UPDATE SET
        activity=activity+1, activity_at_ms=excluded.activity_at_ms;
END;
