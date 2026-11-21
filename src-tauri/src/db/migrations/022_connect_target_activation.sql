-- A published target records here that the relay acknowledged its activation.
-- A published target without this row has not recorded its activation yet and
-- retries it at startup. The row is written once and never changes.
CREATE TABLE connect_recorded_activations (
 transfer_id TEXT PRIMARY KEY REFERENCES connect_activation_receipts(transfer_id) ON DELETE RESTRICT
);
CREATE TRIGGER connect_recorded_activation_update BEFORE UPDATE ON connect_recorded_activations BEGIN SELECT RAISE(ABORT,'connect_activation_immutable'); END;
CREATE TRIGGER connect_recorded_activation_delete BEFORE DELETE ON connect_recorded_activations BEGIN SELECT RAISE(ABORT,'connect_activation_immutable'); END;
