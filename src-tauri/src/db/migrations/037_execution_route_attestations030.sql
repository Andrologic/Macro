-- Native-only attestations. Writers must derive them from authenticated 04/11
-- receipts and the captured reducer state, never from a model or helper result.
CREATE TABLE engine_flow030_route_source_attestations (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, prepare_id TEXT NOT NULL,
 preparation_effect_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 capture_sha256 TEXT NOT NULL, native_receipt_id TEXT NOT NULL,
 receipt_kind TEXT NOT NULL CHECK(receipt_kind IN ('agentWork','call','human','join','error')),
 work_event_id TEXT, producer_json TEXT NOT NULL CHECK(json_valid(producer_json)),
 source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 PRIMARY KEY(system_id,invocation_id,prepare_id),
 UNIQUE(system_id,invocation_id,native_receipt_id),
 FOREIGN KEY(system_id,invocation_id,preparation_effect_id)
 REFERENCES engine_flow030_outbox(system_id,invocation_id,effect_id),
 FOREIGN KEY(system_id,invocation_id,work_event_id)
 REFERENCES engine_flow030_work_events(system_id,invocation_id,event_id),
 CHECK(receipt_kind <> 'agentWork' OR work_event_id IS NOT NULL)
);
CREATE TABLE engine_flow030_route_content_contexts (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, prepare_id TEXT NOT NULL,
 target_ordinal INTEGER NOT NULL CHECK(target_ordinal>=0),
 item_index TEXT NOT NULL CHECK(item_index='0' OR (item_index NOT GLOB '*[^0-9]*' AND substr(item_index,1,1) BETWEEN '1' AND '9')),
 context_id TEXT NOT NULL, owner_epoch TEXT NOT NULL, generation TEXT NOT NULL,
 capture_sha256 TEXT NOT NULL, target_address_json TEXT NOT NULL CHECK(json_valid(target_address_json)),
 recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('agent','approval','compose')),
 recipient_agent TEXT, identity_json TEXT NOT NULL CHECK(json_valid(identity_json)),
 policy_evidence_json TEXT NOT NULL CHECK(json_valid(policy_evidence_json)),
 status TEXT NOT NULL CHECK(status IN ('live','revoked')),
 PRIMARY KEY(system_id,invocation_id,prepare_id,target_ordinal,item_index),
 UNIQUE(system_id,invocation_id,context_id),
 FOREIGN KEY(system_id,invocation_id,prepare_id)
 REFERENCES engine_flow030_route_source_attestations(system_id,invocation_id,prepare_id)
);
CREATE TABLE engine_flow030_route_content_receipts (
 system_id TEXT NOT NULL, invocation_id TEXT NOT NULL, context_id TEXT NOT NULL,
 receipt_sha256 TEXT NOT NULL, source_json TEXT NOT NULL CHECK(json_valid(source_json)),
 native_receipt_json TEXT NOT NULL CHECK(json_valid(native_receipt_json)),
 transport_receipt_json TEXT NOT NULL CHECK(json_valid(transport_receipt_json)),
 PRIMARY KEY(system_id,invocation_id,context_id,receipt_sha256),
 FOREIGN KEY(system_id,invocation_id,context_id)
 REFERENCES engine_flow030_route_content_contexts(system_id,invocation_id,context_id)
);
CREATE TRIGGER engine_flow030_route_source_immutable BEFORE UPDATE ON engine_flow030_route_source_attestations BEGIN SELECT RAISE(ABORT,'immutable native route source'); END;
CREATE TRIGGER engine_flow030_route_source_retained BEFORE DELETE ON engine_flow030_route_source_attestations BEGIN SELECT RAISE(ABORT,'retained native route source'); END;
CREATE TRIGGER engine_flow030_route_context_immutable BEFORE UPDATE OF system_id,invocation_id,prepare_id,target_ordinal,item_index,context_id,owner_epoch,generation,capture_sha256,target_address_json,recipient_kind,recipient_agent,identity_json,policy_evidence_json ON engine_flow030_route_content_contexts BEGIN SELECT RAISE(ABORT,'immutable native content context'); END;
CREATE TRIGGER engine_flow030_route_context_revoked BEFORE UPDATE OF status ON engine_flow030_route_content_contexts WHEN OLD.status='revoked' AND NEW.status<>'revoked' BEGIN SELECT RAISE(ABORT,'revoked native content context'); END;
CREATE TRIGGER engine_flow030_route_context_retained BEFORE DELETE ON engine_flow030_route_content_contexts BEGIN SELECT RAISE(ABORT,'retained native content context'); END;
CREATE TRIGGER engine_flow030_route_content_immutable BEFORE UPDATE ON engine_flow030_route_content_receipts BEGIN SELECT RAISE(ABORT,'immutable native content receipt'); END;
CREATE TRIGGER engine_flow030_route_content_retained BEFORE DELETE ON engine_flow030_route_content_receipts BEGIN SELECT RAISE(ABORT,'retained native content receipt'); END;
