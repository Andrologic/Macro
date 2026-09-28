//! Durable goal state and the single audit identity for each executor turn.
use super::{DbError, DbResult};
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqliteRow;
use sqlx::{Row, SqlitePool};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum GoalStatus {
    ActiveReady,
    ExecutorRunning,
    AuditPending,
    Auditing,
    ContinuationPending,
    AwaitingUser,
    Paused,
    Achieved,
    Error,
}

impl GoalStatus {
    fn as_str(self) -> &'static str {
        match self {
            Self::ActiveReady => "active_ready",
            Self::ExecutorRunning => "executor_running",
            Self::AuditPending => "audit_pending",
            Self::Auditing => "auditing",
            Self::ContinuationPending => "continuation_pending",
            Self::AwaitingUser => "awaiting_user",
            Self::Paused => "paused",
            Self::Achieved => "achieved",
            Self::Error => "error",
        }
    }
    fn parse(raw: &str) -> DbResult<Self> {
        serde_json::from_str(&format!("\"{raw}\"")).map_err(|_| invalid("Unknown goal status"))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum GoalAuditStatus {
    Queued,
    Running,
    ReadyForVerdict,
    Interrupted,
    Applied,
    Failed,
}

impl GoalAuditStatus {
    fn parse(raw: &str) -> DbResult<Self> {
        serde_json::from_str(&format!("\"{raw}\""))
            .map_err(|_| invalid("Unknown goal audit status"))
    }
    fn as_str(self) -> &'static str {
        match self {
            Self::Queued => "queued",
            Self::Running => "running",
            Self::ReadyForVerdict => "ready_for_verdict",
            Self::Interrupted => "interrupted",
            Self::Applied => "applied",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationGoal {
    pub conversation_id: String,
    pub goal_id: String,
    pub revision: i64,
    pub is_current: bool,
    pub objective: String,
    pub success_criteria: Vec<String>,
    pub status: GoalStatus,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub latest_verdict: Option<GoalVerdict>,
    pub audit_count: i64,
    pub continuation_count: i64,
    pub executor_turn_count: i64,
    pub created_at: String,
    pub updated_at: String,
    pub last_audited_at: Option<String>,
    pub last_executor_turn_at: Option<String>,
    pub awaiting_user_since_at: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ConversationGoalAudit {
    pub audit_id: String,
    pub conversation_id: String,
    pub goal_id: String,
    pub goal_revision: i64,
    pub executor_turn_id: String,
    pub current_run_id: String,
    pub status: GoalAuditStatus,
    pub verdict: Option<GoalVerdict>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum GoalVerdictKind {
    Continue,
    Achieved,
    NeedsUser,
    CannotProgress,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum GoalCriterionStatus {
    Met,
    Unmet,
    Uncertain,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct GoalEvidence {
    pub source: String,
    pub finding: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct GoalCriterionResult {
    pub criterion: String,
    pub status: GoalCriterionStatus,
    pub evidence: Vec<GoalEvidence>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct GoalVerdict {
    pub verdict: GoalVerdictKind,
    pub summary: String,
    pub criteria: Vec<GoalCriterionResult>,
    pub feedback: String,
    pub question_for_user: Option<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ActivateConversationGoalInput {
    pub conversation_id: String,
    pub goal_id: String,
    pub objective: String,
    pub success_criteria: Vec<String>,
    pub provider_id: Option<String>,
    pub model_id: Option<String>,
    pub reasoning_effort: Option<String>,
    pub replace_goal_id: Option<String>,
    pub replace_revision: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConversationGoalInput {
    pub conversation_id: String,
    pub goal_id: String,
    pub expected_revision: i64,
    pub objective: String,
    pub success_criteria: Vec<String>,
    pub status: GoalStatus,
    pub reason: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct DeactivateConversationGoalInput {
    pub conversation_id: String,
    pub goal_id: String,
    pub expected_revision: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ClaimConversationGoalAuditInput {
    pub audit_id: String,
    pub conversation_id: String,
    pub goal_id: String,
    pub expected_revision: i64,
    pub executor_turn_id: String,
    pub run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ResumeConversationGoalAuditInput {
    pub audit_id: String,
    pub expected_run_id: String,
    pub new_run_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "camelCase")]
pub struct ApplyConversationGoalVerdictInput {
    pub audit_id: String,
    pub conversation_id: String,
    pub goal_id: String,
    pub expected_revision: i64,
    pub executor_turn_id: String,
    pub run_id: String,
    pub verdict: GoalVerdict,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, ts_rs::TS)]
#[serde(rename_all = "snake_case")]
pub enum GoalCasOutcome {
    Applied,
    Stale,
    Missing,
    Duplicate,
}

fn invalid(message: impl Into<String>) -> DbError {
    DbError::Validation(message.into())
}
fn nonempty(value: &str, field: &str) -> DbResult<()> {
    if value.trim().is_empty() || value.trim() != value {
        return Err(invalid(format!("Invalid {field}")));
    }
    Ok(())
}

fn folded_text(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

// The frontend trims and collapses whitespace in verdict text before applying it.
// Compare that canonical text while retaining every other JSON field for exact matching.
fn normalize_verdict_text(value: &mut serde_json::Value) {
    fn field(value: &mut serde_json::Value, key: &str) {
        if let Some(serde_json::Value::String(text)) = value.get_mut(key) {
            *text = folded_text(text);
        }
    }
    for key in ["summary", "feedback", "questionForUser"] {
        field(value, key);
    }
    if let Some(criteria) = value
        .get_mut("criteria")
        .and_then(serde_json::Value::as_array_mut)
    {
        for criterion in criteria {
            field(criterion, "criterion");
            if let Some(evidence) = criterion
                .get_mut("evidence")
                .and_then(serde_json::Value::as_array_mut)
            {
                for item in evidence {
                    field(item, "source");
                    field(item, "finding");
                }
            }
        }
    }
}

fn validate_verdict_criteria(verdict: &GoalVerdict, expected: &[String]) -> DbResult<()> {
    if folded_text(&verdict.summary).is_empty()
        || (verdict.verdict != GoalVerdictKind::Achieved
            && folded_text(&verdict.feedback).is_empty())
        || match verdict.verdict {
            GoalVerdictKind::NeedsUser => verdict
                .question_for_user
                .as_deref()
                .is_none_or(|question| folded_text(question).is_empty()),
            _ => verdict.question_for_user.is_some(),
        }
    {
        return Err(invalid("Invalid goal audit verdict text or question"));
    }
    if verdict.criteria.len() != expected.len() {
        return Err(invalid(
            "Verdict criteria do not match stored goal criteria",
        ));
    }
    if verdict.verdict == GoalVerdictKind::Achieved && expected.is_empty() {
        return Err(invalid("Achieved requires at least one proven criterion"));
    }
    for (result, criterion) in verdict.criteria.iter().zip(expected) {
        if folded_text(criterion).is_empty()
            || folded_text(&result.criterion) != folded_text(criterion)
            || result.evidence.is_empty()
            || result.evidence.iter().any(|evidence| {
                folded_text(&evidence.source).is_empty()
                    || folded_text(&evidence.finding).is_empty()
            })
        {
            return Err(invalid("Verdict criterion or evidence is invalid"));
        }
        if verdict.verdict == GoalVerdictKind::Achieved && result.status != GoalCriterionStatus::Met
        {
            return Err(invalid("Achieved requires every criterion to be met"));
        }
    }
    Ok(())
}

fn goal_from_row(row: SqliteRow) -> DbResult<ConversationGoal> {
    let criteria: String = row.get("success_criteria_json");
    let verdict: Option<String> = row.get("latest_verdict_json");
    Ok(ConversationGoal {
        conversation_id: row.get("conversation_id"),
        goal_id: row.get("goal_id"),
        revision: row.get("revision"),
        is_current: row.get::<i64, _>("is_current") == 1,
        objective: row.get("objective"),
        success_criteria: serde_json::from_str(&criteria).map_err(|e| invalid(e.to_string()))?,
        status: GoalStatus::parse(row.get::<&str, _>("status"))?,
        provider_id: row.get("provider_id"),
        model_id: row.get("model_id"),
        reasoning_effort: row.get("reasoning_effort"),
        latest_verdict: verdict
            .map(|v| serde_json::from_str(&v).map_err(|e| invalid(e.to_string())))
            .transpose()?,
        audit_count: row.get("audit_count"),
        continuation_count: row.get("continuation_count"),
        executor_turn_count: row.get("executor_turn_count"),
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
        last_audited_at: row.get("last_audited_at"),
        last_executor_turn_at: row.get("last_executor_turn_at"),
        awaiting_user_since_at: row.get("awaiting_user_since_at"),
        last_error: row.get("last_error"),
    })
}

fn audit_from_row(row: SqliteRow) -> DbResult<ConversationGoalAudit> {
    let verdict: Option<String> = row.get("verdict_json");
    Ok(ConversationGoalAudit {
        audit_id: row.get("audit_id"),
        conversation_id: row.get("conversation_id"),
        goal_id: row.get("goal_id"),
        goal_revision: row.get("goal_revision"),
        executor_turn_id: row.get("executor_turn_id"),
        current_run_id: row.get("current_run_id"),
        status: GoalAuditStatus::parse(row.get::<&str, _>("status"))?,
        verdict: verdict
            .map(|v| serde_json::from_str(&v).map_err(|e| invalid(e.to_string())))
            .transpose()?,
        created_at: row.get("created_at"),
        updated_at: row.get("updated_at"),
    })
}

pub async fn get_current_goal(
    pool: &SqlitePool,
    conversation_id: &str,
) -> DbResult<Option<ConversationGoal>> {
    sqlx::query("SELECT * FROM conversation_goals WHERE conversation_id = ? AND is_current = 1")
        .bind(conversation_id)
        .fetch_optional(pool)
        .await?
        .map(goal_from_row)
        .transpose()
}

pub async fn get_audit(
    pool: &SqlitePool,
    audit_id: &str,
) -> DbResult<Option<ConversationGoalAudit>> {
    sqlx::query("SELECT * FROM conversation_goal_audits WHERE audit_id = ?")
        .bind(audit_id)
        .fetch_optional(pool)
        .await?
        .map(audit_from_row)
        .transpose()
}

pub async fn list_recoverable_audits(pool: &SqlitePool) -> DbResult<Vec<ConversationGoalAudit>> {
    sqlx::query("SELECT * FROM conversation_goal_audits WHERE status IN ('queued', 'running', 'ready_for_verdict', 'interrupted') ORDER BY updated_at, audit_id")
        .fetch_all(pool).await?.into_iter().map(audit_from_row).collect()
}

pub async fn activate_goal(
    pool: &SqlitePool,
    input: ActivateConversationGoalInput,
) -> DbResult<ConversationGoal> {
    nonempty(&input.conversation_id, "conversation id")?;
    nonempty(&input.goal_id, "goal id")?;
    nonempty(&input.objective, "objective")?;
    let criteria =
        serde_json::to_string(&input.success_criteria).map_err(|e| invalid(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    match (&input.replace_goal_id, input.replace_revision) {
        (None, None) => {
            let current: Option<String> = sqlx::query_scalar("SELECT goal_id FROM conversation_goals WHERE conversation_id = ? AND is_current = 1")
                .bind(&input.conversation_id).fetch_optional(&mut *tx).await?;
            if current.is_some() {
                return Err(invalid("Conversation already has an active goal"));
            }
        }
        (Some(id), Some(revision)) => {
            let changed = sqlx::query("UPDATE conversation_goals SET is_current = 0, updated_at = ? WHERE conversation_id = ? AND goal_id = ? AND revision = ? AND is_current = 1")
                .bind(&now).bind(&input.conversation_id).bind(id).bind(revision).execute(&mut *tx).await?.rows_affected();
            if changed != 1 {
                return Err(invalid("Goal replacement is stale or missing"));
            }
        }
        _ => return Err(invalid("Goal replacement requires id and revision")),
    }
    sqlx::query("INSERT INTO conversation_goals (goal_id, conversation_id, revision, objective, success_criteria_json, status, provider_id, model_id, reasoning_effort, created_at, updated_at) VALUES (?, ?, 1, ?, ?, 'active_ready', ?, ?, ?, ?, ?)")
        .bind(&input.goal_id).bind(&input.conversation_id).bind(&input.objective).bind(criteria)
        .bind(&input.provider_id).bind(&input.model_id).bind(&input.reasoning_effort)
        .bind(&now).bind(&now).execute(&mut *tx).await?;
    tx.commit().await?;
    get_current_goal(pool, &input.conversation_id)
        .await?
        .ok_or_else(|| invalid("Created goal is missing"))
}

pub async fn update_goal(
    pool: &SqlitePool,
    input: UpdateConversationGoalInput,
) -> DbResult<GoalCasOutcome> {
    nonempty(&input.objective, "objective")?;
    if matches!(input.status, GoalStatus::Achieved | GoalStatus::Auditing) {
        return Err(invalid(
            "Auditing and achieved require durable audit transitions",
        ));
    }
    let criteria =
        serde_json::to_string(&input.success_criteria).map_err(|e| invalid(e.to_string()))?;
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let changed = sqlx::query("UPDATE conversation_goals SET revision = revision + 1, objective = ?, success_criteria_json = ?, status = ?, updated_at = ?, last_executor_turn_at = CASE WHEN ? = 'audit_pending' THEN ? ELSE last_executor_turn_at END, executor_turn_count = executor_turn_count + CASE WHEN ? = 'audit_pending' THEN 1 ELSE 0 END, awaiting_user_since_at = CASE WHEN ? = 'awaiting_user' THEN ? ELSE NULL END, last_error = CASE WHEN ? = 'error' THEN ? ELSE NULL END WHERE conversation_id = ? AND goal_id = ? AND revision = ? AND is_current = 1")
        .bind(&input.objective).bind(criteria).bind(input.status.as_str()).bind(&now)
        .bind(input.status.as_str()).bind(&now).bind(input.status.as_str())
        .bind(input.status.as_str()).bind(&now).bind(input.status.as_str()).bind(&input.reason)
        .bind(&input.conversation_id).bind(&input.goal_id).bind(input.expected_revision)
        .execute(&mut *tx).await?.rows_affected();
    let outcome = if changed == 1 {
        GoalCasOutcome::Applied
    } else {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM conversation_goals WHERE conversation_id = ? AND goal_id = ? AND is_current = 1")
            .bind(&input.conversation_id).bind(&input.goal_id).fetch_optional(&mut *tx).await?;
        if exists.is_some() {
            GoalCasOutcome::Stale
        } else {
            GoalCasOutcome::Missing
        }
    };
    tx.commit().await?;
    Ok(outcome)
}

pub async fn deactivate_goal(
    pool: &SqlitePool,
    input: DeactivateConversationGoalInput,
) -> DbResult<GoalCasOutcome> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let changed = sqlx::query("UPDATE conversation_goals SET is_current = 0, revision = revision + 1, updated_at = ? WHERE conversation_id = ? AND goal_id = ? AND revision = ? AND is_current = 1")
        .bind(chrono::Utc::now().to_rfc3339()).bind(&input.conversation_id).bind(&input.goal_id)
        .bind(input.expected_revision).execute(&mut *tx).await?.rows_affected();
    let outcome = if changed == 1 {
        GoalCasOutcome::Applied
    } else {
        let exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM conversation_goals WHERE conversation_id = ? AND goal_id = ? AND is_current = 1")
            .bind(&input.conversation_id).bind(&input.goal_id).fetch_optional(&mut *tx).await?;
        if exists.is_some() {
            GoalCasOutcome::Stale
        } else {
            GoalCasOutcome::Missing
        }
    };
    tx.commit().await?;
    Ok(outcome)
}

async fn validated_run(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    run_id: &str,
    conversation_id: &str,
) -> DbResult<GoalAuditStatus> {
    let run = sqlx::query(
        "SELECT parent_conversation_id, agent_profile, depth, status FROM agent_runs WHERE id = ?",
    )
    .bind(run_id)
    .fetch_optional(&mut **tx)
    .await?
    .ok_or_else(|| invalid("Goal audit run is missing"))?;
    if run.get::<&str, _>("parent_conversation_id") != conversation_id
        || run.get::<&str, _>("agent_profile") != "goal_auditor"
        || run.get::<i64, _>("depth") != 1
    {
        return Err(invalid("Goal audit run identity mismatch"));
    }
    let claimed: Option<i64> = sqlx::query_scalar("SELECT 1 FROM agent_run_transitions WHERE run_id = ? AND sequence = 0 AND state = 'queued'")
        .bind(run_id).fetch_optional(&mut **tx).await?;
    if claimed.is_none() {
        return Err(invalid(
            "Goal audit run lacks its durable queued transition",
        ));
    }
    if run.get::<&str, _>("status") != "queued" {
        return Err(invalid("Goal audit must be claimed before the run starts"));
    }
    Ok(GoalAuditStatus::Queued)
}

pub(super) async fn claim_audit_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    input: &ClaimConversationGoalAuditInput,
) -> DbResult<()> {
    for (value, field) in [
        (&input.audit_id, "audit id"),
        (&input.executor_turn_id, "executor turn id"),
        (&input.run_id, "run id"),
    ] {
        nonempty(value, field)?;
    }
    let now = chrono::Utc::now().to_rfc3339();
    let revision: Option<i64> = sqlx::query_scalar("SELECT revision FROM conversation_goals WHERE conversation_id = ? AND goal_id = ? AND is_current = 1")
        .bind(&input.conversation_id).bind(&input.goal_id).fetch_optional(&mut **tx).await?;
    if revision != Some(input.expected_revision) {
        return Err(invalid("Goal audit revision is stale or missing"));
    }
    let turn_exists: Option<i64> = sqlx::query_scalar("SELECT 1 FROM messages WHERE conversation_id = ? AND turn_id = ? AND role = 'assistant' LIMIT 1")
        .bind(&input.conversation_id).bind(&input.executor_turn_id).fetch_optional(&mut **tx).await?;
    if turn_exists.is_none() {
        return Err(invalid("Executor turn is missing from parent conversation"));
    }
    let status = validated_run(tx, &input.run_id, &input.conversation_id).await?;
    let claimed = sqlx::query("INSERT OR IGNORE INTO conversation_goal_audits (audit_id, conversation_id, goal_id, goal_revision, executor_turn_id, current_run_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(&input.audit_id).bind(&input.conversation_id).bind(&input.goal_id).bind(input.expected_revision)
        .bind(&input.executor_turn_id).bind(&input.run_id).bind(status.as_str()).bind(&now).bind(&now)
        .execute(&mut **tx).await?.rows_affected();
    if claimed != 1 {
        return Err(invalid("Executor turn or run already has an audit"));
    }
    sqlx::query("INSERT INTO conversation_goal_audit_runs (audit_id, run_id, attempt, linked_at) VALUES (?, ?, 1, ?)")
        .bind(&input.audit_id).bind(&input.run_id).bind(&now).execute(&mut **tx).await?;
    sqlx::query("UPDATE conversation_goals SET status = 'auditing', updated_at = ? WHERE conversation_id = ? AND goal_id = ? AND revision = ? AND is_current = 1")
        .bind(&now).bind(&input.conversation_id).bind(&input.goal_id).bind(input.expected_revision)
        .execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
pub async fn claim_audit(
    pool: &SqlitePool,
    input: ClaimConversationGoalAuditInput,
) -> DbResult<ConversationGoalAudit> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    claim_audit_in_transaction(&mut tx, &input).await?;
    tx.commit().await?;
    get_audit(pool, &input.audit_id)
        .await?
        .ok_or_else(|| invalid("Claimed audit is missing"))
}

pub async fn reconcile_audits_after_restart(pool: &SqlitePool) -> DbResult<u64> {
    let now = chrono::Utc::now().to_rfc3339();
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    sqlx::query("UPDATE conversation_goals SET status = 'paused', last_error = NULL, updated_at = ? WHERE status = 'auditing' AND is_current = 1 AND EXISTS (SELECT 1 FROM conversation_goal_audits AS audit WHERE audit.conversation_id = conversation_goals.conversation_id AND audit.goal_id = conversation_goals.goal_id AND audit.goal_revision = conversation_goals.revision AND audit.status IN ('queued', 'running'))")
        .bind(&now).execute(&mut *tx).await?;
    let count = sqlx::query("UPDATE conversation_goal_audits SET status = 'interrupted', updated_at = ? WHERE status IN ('queued', 'running')")
        .bind(&now).execute(&mut *tx).await?.rows_affected();
    tx.commit().await?;
    Ok(count)
}

pub(super) async fn resume_audit_in_transaction(
    tx: &mut sqlx::Transaction<'_, sqlx::Sqlite>,
    input: &ResumeConversationGoalAuditInput,
) -> DbResult<()> {
    nonempty(&input.new_run_id, "new run id")?;
    if input.new_run_id == input.expected_run_id {
        return Err(invalid("Resume requires a new run"));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let row = sqlx::query("SELECT conversation_id, goal_id, goal_revision, current_run_id, status FROM conversation_goal_audits WHERE audit_id = ?")
        .bind(&input.audit_id).fetch_optional(&mut **tx).await?.ok_or_else(|| invalid("Audit is missing"))?;
    if row.get::<&str, _>("status") != "interrupted"
        || row.get::<&str, _>("current_run_id") != input.expected_run_id
    {
        return Err(invalid("Audit is not resumable from the expected run"));
    }
    let conversation_id: &str = row.get("conversation_id");
    let goal_id: &str = row.get("goal_id");
    let revision: i64 = row.get("goal_revision");
    let current_revision: Option<i64> = sqlx::query_scalar("SELECT revision FROM conversation_goals WHERE conversation_id = ? AND goal_id = ? AND is_current = 1")
        .bind(conversation_id).bind(goal_id).fetch_optional(&mut **tx).await?;
    if current_revision != Some(revision) {
        return Err(invalid("Goal changed since audit interruption"));
    }
    let status = validated_run(tx, &input.new_run_id, conversation_id).await?;
    let attempt: i64 = sqlx::query_scalar(
        "SELECT COALESCE(MAX(attempt), 0) + 1 FROM conversation_goal_audit_runs WHERE audit_id = ?",
    )
    .bind(&input.audit_id)
    .fetch_one(&mut **tx)
    .await?;
    sqlx::query("UPDATE conversation_goal_audits SET current_run_id = ?, status = ?, updated_at = ? WHERE audit_id = ?")
        .bind(&input.new_run_id).bind(status.as_str()).bind(&now).bind(&input.audit_id).execute(&mut **tx).await?;
    sqlx::query("INSERT INTO conversation_goal_audit_runs (audit_id, run_id, attempt, linked_at) VALUES (?, ?, ?, ?)")
        .bind(&input.audit_id).bind(&input.new_run_id).bind(attempt).bind(&now).execute(&mut **tx).await?;
    sqlx::query("UPDATE conversation_goals SET status = 'auditing', updated_at = ? WHERE conversation_id = ? AND goal_id = ? AND revision = ? AND is_current = 1")
        .bind(&now).bind(conversation_id).bind(goal_id).bind(revision)
        .execute(&mut **tx).await?;
    Ok(())
}

#[cfg(test)]
pub async fn resume_audit(
    pool: &SqlitePool,
    input: ResumeConversationGoalAuditInput,
) -> DbResult<ConversationGoalAudit> {
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    resume_audit_in_transaction(&mut tx, &input).await?;
    tx.commit().await?;
    get_audit(pool, &input.audit_id)
        .await?
        .ok_or_else(|| invalid("Resumed audit is missing"))
}

pub async fn apply_verdict(
    pool: &SqlitePool,
    input: ApplyConversationGoalVerdictInput,
) -> DbResult<GoalCasOutcome> {
    if !input.verdict.confidence.is_finite() || !(0.0..=1.0).contains(&input.verdict.confidence) {
        return Err(invalid("Invalid verdict confidence"));
    }
    let now = chrono::Utc::now().to_rfc3339();
    let verdict = serde_json::to_value(&input.verdict).map_err(|e| invalid(e.to_string()))?;
    let verdict_json = serde_json::to_string(&verdict).map_err(|e| invalid(e.to_string()))?;
    let mut tx = pool.begin_with("BEGIN IMMEDIATE").await?;
    let row = sqlx::query("SELECT conversation_id, goal_id, goal_revision, executor_turn_id, current_run_id, status FROM conversation_goal_audits WHERE audit_id = ?")
        .bind(&input.audit_id).fetch_optional(&mut *tx).await?;
    let Some(row) = row else {
        return Ok(GoalCasOutcome::Missing);
    };
    if row.get::<&str, _>("conversation_id") != input.conversation_id
        || row.get::<&str, _>("goal_id") != input.goal_id
        || row.get::<&str, _>("executor_turn_id") != input.executor_turn_id
        || row.get::<&str, _>("current_run_id") != input.run_id
    {
        return Err(invalid("Goal audit identity mismatch"));
    }
    if row.get::<&str, _>("status") == "applied" {
        return Ok(GoalCasOutcome::Duplicate);
    }
    if row.get::<i64, _>("goal_revision") != input.expected_revision {
        return Ok(GoalCasOutcome::Stale);
    }
    let current = sqlx::query("SELECT revision, success_criteria_json FROM conversation_goals WHERE conversation_id = ? AND goal_id = ? AND is_current = 1")
        .bind(&input.conversation_id).bind(&input.goal_id).fetch_optional(&mut *tx).await?;
    let current = match current {
        None => return Ok(GoalCasOutcome::Missing),
        Some(row) if row.get::<i64, _>("revision") != input.expected_revision => {
            return Ok(GoalCasOutcome::Stale)
        }
        Some(row) => row,
    };
    let criteria: Vec<String> =
        serde_json::from_str(current.get::<&str, _>("success_criteria_json"))
            .map_err(|error| invalid(error.to_string()))?;
    validate_verdict_criteria(&input.verdict, &criteria)?;
    if row.get::<&str, _>("status") != "ready_for_verdict" {
        return Err(invalid("Audit run has no durable completed verdict"));
    }
    let run = sqlx::query("SELECT status, result_json, result_text FROM agent_runs WHERE id = ?")
        .bind(&input.run_id)
        .fetch_one(&mut *tx)
        .await?;
    if run.get::<&str, _>("status") != "completed" {
        return Err(invalid("Audit run is not completed"));
    }
    let terminal: Option<String> = sqlx::query_scalar(
        "SELECT state FROM agent_run_transitions WHERE run_id = ? ORDER BY sequence DESC LIMIT 1",
    )
    .bind(&input.run_id)
    .fetch_optional(&mut *tx)
    .await?;
    if terminal.as_deref() != Some("completed") {
        return Err(invalid("Audit run lacks its durable completed transition"));
    }
    let run_result: Option<String> = run
        .get::<Option<String>, _>("result_json")
        .or_else(|| run.get::<Option<String>, _>("result_text"));
    let mut run_verdict: serde_json::Value = serde_json::from_str(
        run_result
            .as_deref()
            .ok_or_else(|| invalid("Audit run has no verdict"))?,
    )
    .map_err(|_| invalid("Audit run verdict is invalid JSON"))?;
    let mut normalized_verdict = verdict.clone();
    normalize_verdict_text(&mut run_verdict);
    normalize_verdict_text(&mut normalized_verdict);
    if run_verdict != normalized_verdict {
        return Err(invalid("Verdict differs from durable run output"));
    }
    let status = match input.verdict.verdict {
        GoalVerdictKind::Achieved => GoalStatus::Achieved,
        GoalVerdictKind::NeedsUser => GoalStatus::AwaitingUser,
        GoalVerdictKind::Continue => GoalStatus::ContinuationPending,
        GoalVerdictKind::CannotProgress => GoalStatus::Paused,
    };
    let continuation: i64 = i64::from(matches!(input.verdict.verdict, GoalVerdictKind::Continue));
    let changed = sqlx::query("UPDATE conversation_goals SET revision = revision + 1, status = ?, latest_verdict_json = ?, audit_count = audit_count + 1, continuation_count = continuation_count + ?, last_audited_at = ?, updated_at = ?, awaiting_user_since_at = CASE WHEN ? = 'awaiting_user' THEN ? ELSE NULL END, last_error = NULL WHERE conversation_id = ? AND goal_id = ? AND revision = ? AND is_current = 1")
        .bind(status.as_str()).bind(&verdict_json).bind(continuation).bind(&now).bind(&now)
        .bind(status.as_str()).bind(&now)
        .bind(&input.conversation_id).bind(&input.goal_id).bind(input.expected_revision)
        .execute(&mut *tx).await?.rows_affected();
    if changed != 1 {
        return Err(invalid("Goal changed during verdict transaction"));
    }
    sqlx::query("UPDATE conversation_goal_audits SET status = 'applied', verdict_json = ?, updated_at = ? WHERE audit_id = ? AND current_run_id = ?")
        .bind(verdict_json).bind(now).bind(&input.audit_id).bind(&input.run_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(GoalCasOutcome::Applied)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agent_runs;
    use crate::db::goal_audit_transitions::{
        self, GoalAuditTransition, RecordGoalAuditTransitionInput,
    };
    use crate::db::models::{AgentRunStatus, AgentRunUsageInput, CreateAgentRunInput};

    async fn fixture() -> (tempfile::TempDir, SqlitePool) {
        let temp = tempfile::tempdir().unwrap();
        let pool = crate::db::create_pool(&temp.path().join("goals.db"))
            .await
            .unwrap();
        sqlx::query("INSERT INTO conversations (id, title, created_at, updated_at) VALUES ('parent', 'Parent', '2026-01-01', '2026-01-01')")
            .execute(&pool).await.unwrap();
        for (id, turn) in [("message-1", "turn-1"), ("message-2", "turn-2")] {
            sqlx::query("INSERT INTO messages (id, conversation_id, turn_id, role, content, created_at) VALUES (?, 'parent', ?, 'assistant', 'Done', '2026-01-01')")
                .bind(id).bind(turn).execute(&pool).await.unwrap();
        }
        (temp, pool)
    }

    fn activation() -> ActivateConversationGoalInput {
        ActivateConversationGoalInput {
            conversation_id: "parent".into(),
            goal_id: "goal-1".into(),
            objective: "Ship feature".into(),
            success_criteria: vec!["Checks pass".into()],
            provider_id: None,
            model_id: None,
            reasoning_effort: None,
            replace_goal_id: None,
            replace_revision: None,
        }
    }

    async fn transition(pool: &SqlitePool, id: &str, sequence: i64, state: AgentRunStatus) {
        transition_with_verdict(pool, id, sequence, state, None).await;
    }

    async fn transition_with_verdict(
        pool: &SqlitePool,
        id: &str,
        sequence: i64,
        state: AgentRunStatus,
        raw_verdict: Option<serde_json::Value>,
    ) {
        let result = (state == AgentRunStatus::Completed).then(|| {
            serde_json::json!({
                "runId": id, "parentConversationId": "parent", "status": "completed",
                "output": { "structured": raw_verdict.unwrap_or_else(|| serde_json::json!(verdict())) }
            })
        });
        let input = RecordGoalAuditTransitionInput {
            descriptor: (sequence == 0).then(|| CreateAgentRunInput {
                id: Some(id.into()),
                parent_conversation_id: "parent".into(),
                child_conversation_id: None,
                agent_profile: "goal_auditor".into(),
                depth: 1,
                prompt: "Audit".into(),
                model_metadata_json: None,
            }),
            audit_claim: None,
            audit_resume: None,
            transition: GoalAuditTransition {
                run_id: id.into(),
                parent_conversation_id: "parent".into(),
                sequence,
                previous_state: match sequence {
                    0 => None,
                    1 => Some(AgentRunStatus::Queued),
                    _ => Some(AgentRunStatus::Running),
                },
                state,
                occurred_at: chrono::Utc::now().timestamp_millis(),
                snapshot: serde_json::json!({"runId": id, "parentConversationId": "parent", "state": state.as_str()}),
                result,
            },
            usage: AgentRunUsageInput::default(),
        };
        goal_audit_transitions::record_goal_audit_transition(pool, input)
            .await
            .unwrap();
    }

    async fn run(pool: &SqlitePool, id: &str) {
        transition(pool, id, 0, AgentRunStatus::Queued).await;
    }

    fn claim(
        audit: &str,
        turn: &str,
        run_id: &str,
        revision: i64,
    ) -> ClaimConversationGoalAuditInput {
        ClaimConversationGoalAuditInput {
            audit_id: audit.into(),
            conversation_id: "parent".into(),
            goal_id: "goal-1".into(),
            expected_revision: revision,
            executor_turn_id: turn.into(),
            run_id: run_id.into(),
        }
    }

    fn verdict() -> GoalVerdict {
        GoalVerdict {
            verdict: GoalVerdictKind::Continue,
            summary: "Continue".into(),
            criteria: vec![GoalCriterionResult {
                criterion: "Checks pass".into(),
                status: GoalCriterionStatus::Unmet,
                evidence: vec![GoalEvidence {
                    source: "test".into(),
                    finding: "Pending".into(),
                }],
            }],
            feedback: "Run checks".into(),
            question_for_user: None,
            confidence: 0.8,
        }
    }

    fn application(
        audit: &str,
        turn: &str,
        run_id: &str,
        revision: i64,
    ) -> ApplyConversationGoalVerdictInput {
        ApplyConversationGoalVerdictInput {
            audit_id: audit.into(),
            conversation_id: "parent".into(),
            goal_id: "goal-1".into(),
            expected_revision: revision,
            executor_turn_id: turn.into(),
            run_id: run_id.into(),
            verdict: verdict(),
        }
    }

    async fn complete(pool: &SqlitePool, id: &str) {
        transition(pool, id, 1, AgentRunStatus::Running).await;
        transition(pool, id, 2, AgentRunStatus::Completed).await;
    }

    #[tokio::test]
    async fn activation_update_and_replacement_preserve_revisions_and_criteria() {
        let (_temp, pool) = fixture().await;
        let goal = activate_goal(&pool, activation()).await.unwrap();
        assert_eq!(goal.revision, 1);
        assert_eq!(goal.success_criteria, ["Checks pass"]);
        assert!(update_goal(
            &pool,
            UpdateConversationGoalInput {
                conversation_id: "parent".into(),
                goal_id: "goal-1".into(),
                expected_revision: 1,
                objective: "Ship feature".into(),
                success_criteria: vec![],
                status: GoalStatus::Auditing,
                reason: None,
            }
        )
        .await
        .is_err());
        assert!(activate_goal(&pool, activation()).await.is_err());
        let update = UpdateConversationGoalInput {
            conversation_id: "parent".into(),
            goal_id: "goal-1".into(),
            expected_revision: 1,
            objective: "Ship and check".into(),
            success_criteria: vec!["Tests pass".into()],
            status: GoalStatus::ActiveReady,
            reason: None,
        };
        assert_eq!(
            update_goal(&pool, update.clone()).await.unwrap(),
            GoalCasOutcome::Applied
        );
        assert_eq!(
            update_goal(&pool, update).await.unwrap(),
            GoalCasOutcome::Stale
        );
        let goal = get_current_goal(&pool, "parent").await.unwrap().unwrap();
        assert_eq!(goal.revision, 2);
        assert_eq!(goal.success_criteria, ["Tests pass"]);
        let mut replacement = activation();
        replacement.goal_id = "goal-2".into();
        replacement.replace_goal_id = Some("goal-1".into());
        replacement.replace_revision = Some(2);
        activate_goal(&pool, replacement).await.unwrap();
        assert_eq!(
            get_current_goal(&pool, "parent")
                .await
                .unwrap()
                .unwrap()
                .goal_id,
            "goal-2"
        );
        assert_eq!(
            update_goal(
                &pool,
                UpdateConversationGoalInput {
                    conversation_id: "parent".into(),
                    goal_id: "goal-1".into(),
                    expected_revision: 2,
                    objective: "Old".into(),
                    success_criteria: vec![],
                    status: GoalStatus::ActiveReady,
                    reason: None,
                }
            )
            .await
            .unwrap(),
            GoalCasOutcome::Missing
        );
    }

    #[tokio::test]
    async fn stop_is_a_durable_cas_and_banner_fields_survive_reopen() {
        let (temp, pool) = fixture().await;
        activate_goal(&pool, activation()).await.unwrap();
        let mut update = UpdateConversationGoalInput {
            conversation_id: "parent".into(),
            goal_id: "goal-1".into(),
            expected_revision: 1,
            objective: "Ship feature".into(),
            success_criteria: vec![],
            status: GoalStatus::AuditPending,
            reason: None,
        };
        assert_eq!(
            update_goal(&pool, update.clone()).await.unwrap(),
            GoalCasOutcome::Applied
        );
        let goal = get_current_goal(&pool, "parent").await.unwrap().unwrap();
        assert_eq!(goal.executor_turn_count, 1);
        assert!(goal.last_executor_turn_at.is_some());
        update.expected_revision = 2;
        update.status = GoalStatus::Error;
        update.reason = Some("Provider stopped".into());
        update_goal(&pool, update.clone()).await.unwrap();
        let goal = get_current_goal(&pool, "parent").await.unwrap().unwrap();
        assert_eq!(goal.last_error.as_deref(), Some("Provider stopped"));
        update.expected_revision = 3;
        update.status = GoalStatus::AwaitingUser;
        update.reason = None;
        update_goal(&pool, update).await.unwrap();
        pool.close().await;
        let reopened = crate::db::create_pool(&temp.path().join("goals.db"))
            .await
            .unwrap();
        let goal = get_current_goal(&reopened, "parent")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(goal.executor_turn_count, 1);
        assert!(goal.last_executor_turn_at.is_some());
        assert!(goal.awaiting_user_since_at.is_some());
        assert_eq!(goal.last_error, None);
        let stop = DeactivateConversationGoalInput {
            conversation_id: "parent".into(),
            goal_id: "goal-1".into(),
            expected_revision: 4,
        };
        assert_eq!(
            deactivate_goal(
                &reopened,
                DeactivateConversationGoalInput {
                    expected_revision: 3,
                    ..stop.clone()
                }
            )
            .await
            .unwrap(),
            GoalCasOutcome::Stale
        );
        assert_eq!(
            deactivate_goal(&reopened, stop.clone()).await.unwrap(),
            GoalCasOutcome::Applied
        );
        assert_eq!(
            deactivate_goal(&reopened, stop).await.unwrap(),
            GoalCasOutcome::Missing
        );
        assert!(get_current_goal(&reopened, "parent")
            .await
            .unwrap()
            .is_none());
        reopened.close().await;
        let reopened = crate::db::create_pool(&temp.path().join("goals.db"))
            .await
            .unwrap();
        assert!(get_current_goal(&reopened, "parent")
            .await
            .unwrap()
            .is_none());
    }

    #[tokio::test]
    async fn claim_refuses_duplicate_turn_and_verdict_cas_is_atomic() {
        let (_temp, pool) = fixture().await;
        activate_goal(&pool, activation()).await.unwrap();
        run(&pool, "run-1").await;
        run(&pool, "run-2").await;
        assert!(claim_audit(&pool, claim("audit-0", "unknown", "run-2", 1))
            .await
            .is_err());
        claim_audit(&pool, claim("audit-1", "turn-1", "run-1", 1))
            .await
            .unwrap();
        assert!(claim_audit(&pool, claim("audit-2", "turn-1", "run-2", 1))
            .await
            .is_err());
        assert!(
            apply_verdict(&pool, application("audit-1", "turn-1", "run-1", 1))
                .await
                .is_err()
        );
        complete(&pool, "run-1").await;
        let mut mismatched = application("audit-1", "turn-1", "run-1", 1);
        mismatched.verdict.summary = "Forged".into();
        assert!(apply_verdict(&pool, mismatched).await.is_err());
        assert_eq!(
            apply_verdict(&pool, application("audit-1", "turn-1", "run-1", 1))
                .await
                .unwrap(),
            GoalCasOutcome::Applied
        );
        assert_eq!(
            apply_verdict(&pool, application("audit-1", "turn-1", "run-1", 1))
                .await
                .unwrap(),
            GoalCasOutcome::Duplicate
        );
        let goal = get_current_goal(&pool, "parent").await.unwrap().unwrap();
        assert_eq!(
            (goal.revision, goal.audit_count, goal.continuation_count),
            (2, 1, 1)
        );
        assert_eq!(goal.status, GoalStatus::ContinuationPending);
        assert_eq!(
            apply_verdict(&pool, application("missing", "turn-1", "run-1", 1))
                .await
                .unwrap(),
            GoalCasOutcome::Missing
        );
    }

    #[tokio::test]
    async fn normalized_verdict_applies_against_raw_durable_provider_output() {
        let (_temp, pool) = fixture().await;
        activate_goal(&pool, activation()).await.unwrap();
        run(&pool, "run-1").await;
        claim_audit(&pool, claim("audit-1", "turn-1", "run-1", 1))
            .await
            .unwrap();
        transition(&pool, "run-1", 1, AgentRunStatus::Running).await;
        let mut raw = serde_json::json!(verdict());
        raw["summary"] = serde_json::json!("  Continue  ");
        raw["feedback"] = serde_json::json!(" Run   checks ");
        raw["criteria"][0]["criterion"] = serde_json::json!(" Checks   pass ");
        raw["criteria"][0]["evidence"][0]["source"] = serde_json::json!(" test ");
        transition_with_verdict(&pool, "run-1", 2, AgentRunStatus::Completed, Some(raw)).await;
        let goal = get_current_goal(&pool, "parent").await.unwrap().unwrap();
        assert_eq!((goal.revision, goal.status), (1, GoalStatus::Auditing));
        assert_eq!(
            apply_verdict(&pool, application("audit-1", "turn-1", "run-1", 1))
                .await
                .unwrap(),
            GoalCasOutcome::Applied
        );
    }

    #[tokio::test]
    async fn native_verdict_rejects_misaligned_or_unproven_criteria_and_missing_question() {
        let mut wrong_criterion = verdict();
        wrong_criterion.criteria[0].criterion = "Other criterion".into();
        let mut missing_criterion = verdict();
        missing_criterion.criteria.clear();
        let mut missing_evidence = verdict();
        missing_evidence.criteria[0].evidence.clear();
        let mut empty_evidence_text = verdict();
        empty_evidence_text.criteria[0].evidence[0].finding = "  ".into();
        let mut unproven_achievement = verdict();
        unproven_achievement.verdict = GoalVerdictKind::Achieved;
        let mut missing_question = verdict();
        missing_question.verdict = GoalVerdictKind::NeedsUser;
        for (case, candidate) in [
            ("wrong criterion", wrong_criterion),
            ("missing criterion", missing_criterion),
            ("missing evidence", missing_evidence),
            ("empty evidence text", empty_evidence_text),
            ("unproven achievement", unproven_achievement),
            ("missing question", missing_question),
        ] {
            let (_temp, pool) = fixture().await;
            activate_goal(&pool, activation()).await.unwrap();
            run(&pool, "run-1").await;
            claim_audit(&pool, claim("audit-1", "turn-1", "run-1", 1))
                .await
                .unwrap();
            transition(&pool, "run-1", 1, AgentRunStatus::Running).await;
            transition_with_verdict(
                &pool,
                "run-1",
                2,
                AgentRunStatus::Completed,
                Some(serde_json::json!(candidate)),
            )
            .await;
            let mut application = application("audit-1", "turn-1", "run-1", 1);
            application.verdict = candidate;
            assert!(apply_verdict(&pool, application).await.is_err(), "{case}");
            let goal = get_current_goal(&pool, "parent").await.unwrap().unwrap();
            assert_eq!(
                (goal.revision, goal.status),
                (1, GoalStatus::Auditing),
                "{case}"
            );
        }
    }

    #[tokio::test]
    async fn empty_criteria_allow_continuation_but_not_achievement() {
        for verdict_kind in [GoalVerdictKind::Achieved, GoalVerdictKind::Continue] {
            let (_temp, pool) = fixture().await;
            let mut goal = activation();
            goal.success_criteria.clear();
            activate_goal(&pool, goal).await.unwrap();
            run(&pool, "run-1").await;
            claim_audit(&pool, claim("audit-1", "turn-1", "run-1", 1))
                .await
                .unwrap();
            transition(&pool, "run-1", 1, AgentRunStatus::Running).await;
            let mut candidate = verdict();
            candidate.verdict = verdict_kind;
            candidate.criteria.clear();
            transition_with_verdict(
                &pool,
                "run-1",
                2,
                AgentRunStatus::Completed,
                Some(serde_json::json!(candidate)),
            )
            .await;
            let mut application = application("audit-1", "turn-1", "run-1", 1);
            application.verdict = candidate;
            let outcome = apply_verdict(&pool, application).await;
            if verdict_kind == GoalVerdictKind::Achieved {
                assert!(outcome.is_err());
            } else {
                assert_eq!(outcome.unwrap(), GoalCasOutcome::Applied);
            }
        }
    }

    #[tokio::test]
    async fn proved_achievement_applies_from_matching_durable_output() {
        let (_temp, pool) = fixture().await;
        activate_goal(&pool, activation()).await.unwrap();
        run(&pool, "run-1").await;
        claim_audit(&pool, claim("audit-1", "turn-1", "run-1", 1))
            .await
            .unwrap();
        transition(&pool, "run-1", 1, AgentRunStatus::Running).await;
        let mut candidate = verdict();
        candidate.verdict = GoalVerdictKind::Achieved;
        candidate.criteria[0].status = GoalCriterionStatus::Met;
        candidate.feedback.clear();
        transition_with_verdict(
            &pool,
            "run-1",
            2,
            AgentRunStatus::Completed,
            Some(serde_json::json!(candidate)),
        )
        .await;
        let mut application = application("audit-1", "turn-1", "run-1", 1);
        application.verdict = candidate;
        assert_eq!(
            apply_verdict(&pool, application).await.unwrap(),
            GoalCasOutcome::Applied
        );
        assert_eq!(
            get_current_goal(&pool, "parent")
                .await
                .unwrap()
                .unwrap()
                .status,
            GoalStatus::Achieved
        );
    }

    #[tokio::test]
    async fn stale_revision_and_interrupted_runs_never_apply_late_verdicts() {
        let (_temp, pool) = fixture().await;
        activate_goal(&pool, activation()).await.unwrap();
        run(&pool, "run-1").await;
        claim_audit(&pool, claim("audit-1", "turn-1", "run-1", 1))
            .await
            .unwrap();
        complete(&pool, "run-1").await;
        update_goal(
            &pool,
            UpdateConversationGoalInput {
                conversation_id: "parent".into(),
                goal_id: "goal-1".into(),
                expected_revision: 1,
                objective: "Changed".into(),
                success_criteria: vec![],
                status: GoalStatus::ActiveReady,
                reason: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            apply_verdict(&pool, application("audit-1", "turn-1", "run-1", 1))
                .await
                .unwrap(),
            GoalCasOutcome::Stale
        );
        let mut replacement = activation();
        replacement.goal_id = "goal-2".into();
        replacement.replace_goal_id = Some("goal-1".into());
        replacement.replace_revision = Some(2);
        activate_goal(&pool, replacement).await.unwrap();
        assert_eq!(
            apply_verdict(&pool, application("audit-1", "turn-1", "run-1", 1))
                .await
                .unwrap(),
            GoalCasOutcome::Missing
        );
    }

    #[tokio::test]
    async fn queued_and_running_recovery_requires_explicit_new_run_and_retains_links() {
        let (_temp, pool) = fixture().await;
        activate_goal(&pool, activation()).await.unwrap();
        run(&pool, "queued-run").await;
        run(&pool, "running-run").await;
        claim_audit(&pool, claim("queued-audit", "turn-1", "queued-run", 1))
            .await
            .unwrap();
        claim_audit(&pool, claim("running-audit", "turn-2", "running-run", 1))
            .await
            .unwrap();
        transition(&pool, "running-run", 1, AgentRunStatus::Running).await;
        assert_eq!(
            get_audit(&pool, "running-audit")
                .await
                .unwrap()
                .unwrap()
                .status,
            GoalAuditStatus::Running
        );
        agent_runs::reconcile_active_agent_runs_after_restart(&pool)
            .await
            .unwrap();
        assert_eq!(reconcile_audits_after_restart(&pool).await.unwrap(), 1);
        for id in ["queued-audit", "running-audit"] {
            assert_eq!(
                get_audit(&pool, id).await.unwrap().unwrap().status,
                GoalAuditStatus::Interrupted
            );
        }
        run(&pool, "resume-run").await;
        assert!(resume_audit(
            &pool,
            ResumeConversationGoalAuditInput {
                audit_id: "queued-audit".into(),
                expected_run_id: "wrong".into(),
                new_run_id: "resume-run".into(),
            }
        )
        .await
        .is_err());
        let resumed = resume_audit(
            &pool,
            ResumeConversationGoalAuditInput {
                audit_id: "queued-audit".into(),
                expected_run_id: "queued-run".into(),
                new_run_id: "resume-run".into(),
            },
        )
        .await
        .unwrap();
        assert_eq!(resumed.status, GoalAuditStatus::Queued);
        let links: Vec<String> = sqlx::query_scalar("SELECT run_id FROM conversation_goal_audit_runs WHERE audit_id = 'queued-audit' ORDER BY attempt")
            .fetch_all(&pool).await.unwrap();
        assert_eq!(links, ["queued-run", "resume-run"]);
        assert!(apply_verdict(
            &pool,
            application("queued-audit", "turn-1", "queued-run", 1)
        )
        .await
        .is_err());
    }
}
