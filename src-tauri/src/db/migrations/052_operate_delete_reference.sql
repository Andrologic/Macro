-- Used on the disposable reference database when validating an older backup.
DROP TRIGGER macro_operate_hold_activity;
DROP TRIGGER macro_operate_shutdown_holds;
DROP TABLE operate_shutdown_holds;
DROP TABLE operate_run_deletions;

DROP TRIGGER engine_start030_entry_retained;
CREATE TRIGGER engine_start030_entry_retained BEFORE DELETE ON engine_start030_entries
BEGIN SELECT RAISE(ABORT, 'retained start entry'); END;

DROP TRIGGER engine_flow030_no_admission_retained;
CREATE TRIGGER engine_flow030_no_admission_retained
BEFORE DELETE ON engine_flow030_no_admissions
BEGIN SELECT RAISE(ABORT, 'retained native no-admission proof'); END;

DROP TRIGGER engine_flow030_handoff_retained;
CREATE TRIGGER engine_flow030_handoff_retained
BEFORE DELETE ON engine_flow030_handoffs
BEGIN SELECT RAISE(ABORT, 'retained native handoff'); END;

DROP TRIGGER engine_flow030_preparation_retained;
CREATE TRIGGER engine_flow030_preparation_retained
BEFORE DELETE ON engine_flow030_preparations
BEGIN SELECT RAISE(ABORT, 'retained native preparation'); END;

DROP TRIGGER engine_flow030_occurrence_provenance_retained;
CREATE TRIGGER engine_flow030_occurrence_provenance_retained
BEFORE DELETE ON engine_flow030_occurrence_provenance
BEGIN SELECT RAISE(ABORT, 'retained native occurrence provenance'); END;

DROP TRIGGER engine_flow030_work_admissions_retained;
CREATE TRIGGER engine_flow030_work_admissions_retained BEFORE DELETE ON engine_flow030_work_admissions BEGIN SELECT RAISE(ABORT,'retained work admission'); END;

DROP TRIGGER engine_flow030_work_authorizations_retained;
CREATE TRIGGER engine_flow030_work_authorizations_retained BEFORE DELETE ON engine_flow030_work_authorizations BEGIN SELECT RAISE(ABORT,'retained work event'); END;

DROP TRIGGER engine_flow030_work_event_retained;
CREATE TRIGGER engine_flow030_work_event_retained
BEFORE DELETE ON engine_flow030_work_events BEGIN SELECT RAISE(ABORT,'retained work event'); END;

DROP TRIGGER engine_flow030_route_source_retained;
CREATE TRIGGER engine_flow030_route_source_retained BEFORE DELETE ON engine_flow030_route_source_attestations BEGIN SELECT RAISE(ABORT,'retained native route source'); END;

DROP TRIGGER engine_flow030_route_context_retained;
CREATE TRIGGER engine_flow030_route_context_retained BEFORE DELETE ON engine_flow030_route_content_contexts BEGIN SELECT RAISE(ABORT,'retained native content context'); END;

DROP TRIGGER engine_flow030_route_content_retained;
CREATE TRIGGER engine_flow030_route_content_retained BEFORE DELETE ON engine_flow030_route_content_receipts BEGIN SELECT RAISE(ABORT,'retained native content receipt'); END;

DROP TRIGGER engine_flow030_system_stop_retained;
CREATE TRIGGER engine_flow030_system_stop_retained BEFORE DELETE ON engine_flow030_system_stop_requests
BEGIN SELECT RAISE(ABORT,'retained system Stop request'); END;

DROP TRIGGER engine_flow030_call_retained;
CREATE TRIGGER engine_flow030_call_retained BEFORE DELETE ON engine_flow030_calls
BEGIN SELECT RAISE(ABORT,'retained native call receipt'); END;

DROP TRIGGER engine_flow030_call_cause_retained;
CREATE TRIGGER engine_flow030_call_cause_retained BEFORE DELETE ON engine_flow030_call_causes
BEGIN SELECT RAISE(ABORT,'retained native call cause'); END;

DROP TRIGGER engine_flow030_call_diagnostic_retained;
CREATE TRIGGER engine_flow030_call_diagnostic_retained BEFORE DELETE ON engine_flow030_call_diagnostics
BEGIN SELECT RAISE(ABORT,'retained native call diagnostic'); END;

DROP TRIGGER engine_flow030_clock_event_retained;
CREATE TRIGGER engine_flow030_clock_event_retained BEFORE DELETE ON engine_flow030_clock_events
BEGIN SELECT RAISE(ABORT,'retained clock journal'); END;

DROP TRIGGER engine_flow030_human_request_retained;
CREATE TRIGGER engine_flow030_human_request_retained BEFORE DELETE ON engine_flow030_human_requests
BEGIN SELECT RAISE(ABORT,'retained human request'); END;

DROP TRIGGER engine_flow030_human_submission_retained;
CREATE TRIGGER engine_flow030_human_submission_retained BEFORE DELETE ON engine_flow030_human_submissions
BEGIN SELECT RAISE(ABORT,'retained human answer'); END;

DROP TRIGGER engine_flow030_clock_cause_retained;
CREATE TRIGGER engine_flow030_clock_cause_retained BEFORE DELETE ON engine_flow030_clock_controls
BEGIN SELECT RAISE(ABORT,'retained timeout cause'); END;

DROP TRIGGER engine_flow030_handoff_clock_retained;
CREATE TRIGGER engine_flow030_handoff_clock_retained BEFORE DELETE ON engine_flow030_handoff_clock
BEGIN SELECT RAISE(ABORT,'retained handoff clock origin'); END;

DROP TRIGGER engine_flow030_human_proof_retained;
CREATE TRIGGER engine_flow030_human_proof_retained BEFORE DELETE ON engine_flow030_human_resolution_proofs
BEGIN SELECT RAISE(ABORT,'retained native human resolution proof'); END;

DROP TRIGGER engine_ui_intent_retained;
CREATE TRIGGER engine_ui_intent_retained BEFORE DELETE ON engine_ui_intents
BEGIN SELECT RAISE(ABORT,'retained execution intent'); END;
