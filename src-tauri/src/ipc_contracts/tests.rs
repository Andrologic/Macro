use super::{chat::AiStreamDoneEvent, db::UpsertConversationCitationInput, files::FileContentDto};
use serde_json::json;
use ts_rs::{Config, TS};

#[test]
fn output_omission_matches_the_generated_contract() {
    let event = AiStreamDoneEvent {
        request_id: "request".into(),
        output_text: "done".into(),
        tool_calls: vec![],
        response_id: None,
        output_items: None,
        provider_input_items: None,
        provider_turn_state: None,
        reasoning_summary: None,
        tool_traces: None,
        hidden_context: None,
        completion_reason: None,
    };
    let mut value = serde_json::to_value(&event).unwrap();
    assert_eq!(
        value,
        json!({"request_id": "request", "output_text": "done", "tool_calls": []})
    );
    let declaration = AiStreamDoneEvent::decl(&Config::default().with_large_int("number"));
    assert!(
        declaration.contains("response_id?: string"),
        "{declaration}"
    );
    let event = AiStreamDoneEvent {
        response_id: Some("response".into()),
        ..event
    };
    value["response_id"] = json!("response");
    assert_eq!(serde_json::to_value(event).unwrap(), value);
}

#[test]
fn citation_input_accepts_omission_and_null_without_changing_the_payload() {
    let input = json!({
        "id": "citation", "conversation_id": "conversation", "message_id": "message",
        "type": "file", "scope": "project", "source": "read", "title": "source"
    });
    let omitted: UpsertConversationCitationInput = serde_json::from_value(input.clone()).unwrap();
    let mut explicit = input;
    explicit["snippet"] = serde_json::Value::Null;
    let explicit: UpsertConversationCitationInput = serde_json::from_value(explicit).unwrap();
    assert_eq!(omitted.snippet, None);
    assert_eq!(explicit.snippet, None);
    // The raw record's Option is nullable; the frontend input adapter also allows omission.
    let declaration = UpsertConversationCitationInput::decl(&Config::default());
    assert!(
        declaration.contains("snippet: string | null"),
        "{declaration}"
    );
}

#[test]
fn json_file_sizes_remain_numbers_and_absent_unix_mode_stays_omitted() {
    let dto = FileContentDto {
        content: "text".into(),
        language: "text".into(),
        is_binary: false,
        size: 4,
        encoding: "utf-8".into(),
        revision: "revision".into(),
        unix_mode: None,
    };
    let value = serde_json::to_value(dto).unwrap();
    assert_eq!(value["size"], json!(4));
    assert!(value.get("unix_mode").is_none());
    let declaration = FileContentDto::decl(&Config::default().with_large_int("number"));
    assert!(declaration.contains("size: number"), "{declaration}");
    assert!(declaration.contains("unix_mode?:"), "{declaration}");
}

#[test]
fn canonical_terminal_fields_keep_the_legacy_input_aliases() {
    use super::terminal::TerminalPromptContext;
    let legacy: TerminalPromptContext =
        serde_json::from_value(json!({"project_label": "project"})).unwrap();
    let canonical: TerminalPromptContext =
        serde_json::from_value(json!({"projectLabel": "project"})).unwrap();
    assert_eq!(legacy.project_label, canonical.project_label);
    assert_eq!(
        serde_json::to_value(legacy).unwrap(),
        json!({
            "projectLabel": "project", "taskLabel": null, "branchLabel": null
        })
    );
    let declaration = TerminalPromptContext::decl(&Config::default());
    assert!(
        declaration.contains("projectLabel: string | null"),
        "{declaration}"
    );
    assert!(!declaration.contains("project_label"), "{declaration}");
}

#[test]
fn flattened_review_fields_match_the_wire_contract() {
    use super::git_commands::{DirectReviewSnapshotDto, GitReviewSnapshotDto};
    let dto = DirectReviewSnapshotDto {
        snapshot: GitReviewSnapshotDto {
            branch: "feature/example".into(),
            staged_paths: vec![],
            changes: vec![],
            conflicted_files: vec![],
            merge_in_progress: false,
            is_clean: true,
        },
        has_accepted_changes: false,
        snapshot_id: "snapshot".into(),
        restore_revisions: Default::default(),
    };
    let value = serde_json::to_value(dto).unwrap();
    assert_eq!(value["branch"], json!("feature/example"));
    assert_eq!(value["stagedPaths"], json!([]));
    assert!(value.get("snapshot").is_none());
    let declaration = DirectReviewSnapshotDto::decl(&Config::default());
    assert!(declaration.contains("branch: string"), "{declaration}");
    assert!(
        declaration.contains("stagedPaths: Array<string>"),
        "{declaration}"
    );
    assert!(!declaration.contains("snapshot:"), "{declaration}");
}

#[test]
fn common_ai_request_preserves_text_parts_and_input_defaults() {
    use super::chat::{AiChatMessageContent, AiChatRequest};
    let request: AiChatRequest = serde_json::from_value(json!({
        "request_id": "request", "provider_id": "provider", "model_id": "model",
        "messages": [
            { "role": "user", "content": "text" },
            { "role": "user", "content": [
                { "type": "text", "text": "caption" },
                { "type": "image_url", "image_url": { "url": "https://example.invalid/image.png" } }
            ] }
        ]
    }))
    .unwrap();
    assert!(request.tools.is_empty());
    assert!(request.allowed_tool_ids.is_empty());
    assert!(request.project_mounts.is_empty());
    assert!(request.reasoning_effort.is_none());
    assert!(
        matches!(&request.messages[0].content, AiChatMessageContent::Text(text) if text == "text")
    );
    assert!(
        matches!(&request.messages[1].content, AiChatMessageContent::Parts(parts) if parts.len() == 2)
    );
    let wire = serde_json::to_value(request).unwrap();
    assert_eq!(wire["messages"][0]["content"], "text");
    assert_eq!(
        wire["messages"][1]["content"][1]["image_url"]["url"],
        "https://example.invalid/image.png"
    );
    assert!(wire["messages"][0].get("provider_turn_state").is_none());
}

#[test]
fn common_ai_trace_keeps_nullable_detail_and_omitted_execution_fields() {
    use super::chat::AiToolTrace;
    let trace: AiToolTrace = serde_json::from_value(json!({
        "tool_call_id": "call", "tool_name": "read", "status": "future_status"
    }))
    .unwrap();
    assert_eq!(
        serde_json::to_value(trace).unwrap(),
        json!({
            "tool_call_id": "call", "tool_name": "read", "status": "future_status", "detail": null
        })
    );
}
