-- Native proof that an exact start effect was never handed to an executor.
CREATE TABLE engine_flow030_no_admissions (
    system_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    start_effect_id TEXT NOT NULL,
    owner_epoch TEXT NOT NULL,
    generation TEXT NOT NULL,
    proof_json TEXT NOT NULL CHECK(json_valid(proof_json)),
    PRIMARY KEY(system_id, invocation_id, start_effect_id),
    FOREIGN KEY(system_id, invocation_id, start_effect_id)
        REFERENCES engine_flow030_outbox(system_id, invocation_id, effect_id)
);
CREATE TRIGGER engine_flow030_no_admission_immutable
BEFORE UPDATE ON engine_flow030_no_admissions
BEGIN SELECT RAISE(ABORT, 'immutable native no-admission proof'); END;
CREATE TRIGGER engine_flow030_no_admission_retained
BEFORE DELETE ON engine_flow030_no_admissions
BEGIN SELECT RAISE(ABORT, 'retained native no-admission proof'); END;
CREATE TRIGGER engine_flow030_handoff_retained
BEFORE DELETE ON engine_flow030_handoffs
BEGIN SELECT RAISE(ABORT, 'retained native handoff'); END;
CREATE TRIGGER engine_flow030_preparation_retained
BEFORE DELETE ON engine_flow030_preparations
BEGIN SELECT RAISE(ABORT, 'retained native preparation'); END;
CREATE TRIGGER engine_flow030_occurrence_provenance_retained
BEFORE DELETE ON engine_flow030_occurrence_provenance
BEGIN SELECT RAISE(ABORT, 'retained native occurrence provenance'); END;
CREATE TRIGGER engine_flow030_no_admission_reject_handoff
BEFORE INSERT ON engine_flow030_no_admissions
WHEN EXISTS(SELECT 1 FROM engine_flow030_handoffs
            WHERE system_id=NEW.system_id AND invocation_id=NEW.invocation_id
              AND effect_id=NEW.start_effect_id)
BEGIN SELECT RAISE(ABORT, 'native effect was already handed off'); END;
CREATE TRIGGER engine_flow030_handoff_reject_no_admission
BEFORE INSERT ON engine_flow030_handoffs
WHEN EXISTS(SELECT 1 FROM engine_flow030_no_admissions
            WHERE system_id=NEW.system_id AND invocation_id=NEW.invocation_id
              AND start_effect_id=NEW.effect_id)
BEGIN SELECT RAISE(ABORT, 'native effect was proven not admitted'); END;
