//! Explicit historical display associations. Labels and run-wide Task IDs grant no link.
use super::*;
use serde_json::Value;
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, ts_rs::TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CardAssociation {
    pub path: String,
    pub task_id: Option<String>,
    pub legacy_node_id: Option<String>,
}
fn part(name: &str) -> String {
    name.replace('~', "~0").replace('/', "~1")
}
fn identity(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|v| !v.is_empty() && v.len() <= 512 && !v.chars().any(char::is_control))
        .map(str::to_owned)
}
pub(crate) fn capture(authored_source: &str, cards_json: &str) -> Result<Vec<CardAssociation>> {
    validate_json(authored_source)?;
    validate_json(cards_json)?;
    let document = super::super::exact_json::value(authored_source)?;
    let cards: Value = serde_json::from_str(cards_json)?;
    let mut paths = BTreeMap::new();
    if let Some(agents) = document.get("agents").and_then(Value::as_object) {
        for name in agents.keys() {
            paths.insert(format!("/agents/{}", part(name)), None);
        }
    }
    if let Some(steps) = document.pointer("/flow/steps").and_then(Value::as_object) {
        for (name, step) in steps {
            let inherited = if step.get("type").and_then(Value::as_str) == Some("agent") {
                step.get("agent")
                    .and_then(Value::as_str)
                    .map(|name| format!("/agents/{}", part(name)))
            } else {
                None
            };
            paths.insert(format!("/flow/steps/{}", part(name)), inherited);
        }
    }
    let mut captured = Vec::new();
    for (path, inherited) in paths {
        let own = cards.get(&path);
        let inherited = inherited.as_ref().and_then(|key| cards.get(key));
        // An explicit empty/null step value removes the inherited association.
        let value = |key: &str| {
            own.and_then(|v| v.get(key))
                .or_else(|| inherited.and_then(|v| v.get(key)))
        };
        let task_id = identity(value("macroTaskId"));
        let legacy_node_id = identity(value("macroLegacyNodeId"));
        if task_id.is_some() || legacy_node_id.is_some() {
            captured.push(CardAssociation {
                path,
                task_id,
                legacy_node_id,
            });
        }
    }
    Ok(captured)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn step_overrides_agent_without_inference_from_title_or_unknown_path() {
        let document = r#"{"agents":{"a/b":{"opaque":{"$serde_json::private::Number":"not a number"}}},"flow":{"steps":{"inherit":{"type":"agent","agent":"a/b"},"override":{"type":"agent","agent":"a/b"},"remove":{"type":"agent","agent":"a/b"},"call":{"type":"call"}}}}"#;
        let cards = r#"{"/agents/a~1b":{"macroTaskId":"agent-task","macroLegacyNodeId":"node","title":"unused"},"/flow/steps/override":{"macroTaskId":"step-task"},"/flow/steps/remove":{"macroTaskId":null,"macroLegacyNodeId":""},"/flow/steps/call":{"title":"agent-task"},"/absent":{"macroTaskId":"foreign"}}"#;
        let captured = capture(document, cards).unwrap();
        assert_eq!(captured.len(), 3);
        assert_eq!(
            captured
                .iter()
                .find(|a| a.path.ends_with("inherit"))
                .unwrap()
                .task_id
                .as_deref(),
            Some("agent-task")
        );
        assert_eq!(
            captured
                .iter()
                .find(|a| a.path.ends_with("override"))
                .unwrap()
                .task_id
                .as_deref(),
            Some("step-task")
        );
        assert!(!serde_json::to_string(&captured)
            .unwrap()
            .contains("foreign"));
    }
}

pub(crate) async fn historical(
    pool: &SqlitePool,
    system_id: &str,
    source: &EngineSourceRevision,
    path: &str,
) -> Result<Option<CardAssociation>> {
    let mut connection = pool.acquire().await?;
    let stored = load(&mut connection, system_id).await?;
    require(
        stored.snapshot.source == *source,
        "Historical card source differs from run",
    )?;
    let capture = stored.capture.ok_or_else(|| {
        failure(
            "VERSION_UNAVAILABLE",
            "cards",
            "Historical card associations are unavailable",
        )
    })?;
    Ok(capture
        .card_associations
        .into_iter()
        .find(|card| card.path == path))
}
