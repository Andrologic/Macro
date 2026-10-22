//! Stop recovery for the qualified local inline executor. HTTP streams and
//! workspace writes are owned by the native process. Terminal, MCP and external
//! process providers are outside this profile. PID reuse or missing provenance
//! refuses recovery; an absent registry entry alone never proves termination.
use super::*;
fn process_dead(pid: i64) -> bool {
    if pid <= 0 || pid > i32::MAX as i64 || pid == i64::from(std::process::id()) {
        return false;
    }
    #[cfg(unix)]
    {
        // EPERM means alive. Only ESRCH proves absence; PID reuse stays blocked.
        unsafe {
            libc::kill(pid as i32, 0) == -1
                && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
        }
    }
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            Foundation::{CloseHandle, GetLastError, ERROR_INVALID_PARAMETER},
            System::Threading::{
                GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
            },
        };
        unsafe {
            let handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid as u32);
            if handle.is_null() {
                return GetLastError() == ERROR_INVALID_PARAMETER;
            }
            let mut code = 259;
            let read = GetExitCodeProcess(handle, &mut code);
            CloseHandle(handle);
            read != 0 && code != 259
        }
    }
    #[cfg(not(any(unix, windows)))]
    {
        false
    }
}
/// Process-local reservation plus a cancellation tombstone proves that this
/// native stream was never admitted. An old process's missing registry does not.
pub(crate) async fn registered_in_this_process(
    pool: &SqlitePool,
    context: &EngineContext,
    effect: &EngineEffectIdentity,
) -> Result<bool> {
    let pid: Option<i64> = sqlx::query_scalar(
        "SELECT process_id FROM engine_effect_processes WHERE system_id=? AND effect_key=?",
    )
    .bind(&context.work.system_start_id)
    .bind(effect_key(effect)?)
    .fetch_optional(pool)
    .await?;
    Ok(pid == Some(i64::from(std::process::id())))
}

pub(crate) async fn close_dead_process_effects(
    pool: &SqlitePool,
    system_id: &str,
    activation_id: Option<&str>,
) -> Result<()> {
    let mut c = pool.acquire().await?;
    let mut tx = durable(&mut c).await?;
    let mut stored = load(&mut tx, system_id).await?;
    require(
        stored.snapshot.versions.profile == "macro-serial-inline-v1",
        "Process recovery requires the qualified local profile",
    )?;
    let rows = sqlx::query("SELECT e.record_json,e.activation_id,p.process_id FROM engine_effects e JOIN engine_effect_processes p ON p.system_id=e.system_id AND p.effect_key=e.effect_key WHERE e.system_id=? AND e.status<>'ended'")
        .bind(system_id).fetch_all(&mut *tx).await?;
    for row in rows {
        let effect: EngineEffect = serde_json::from_str(row.get("record_json"))?;
        let a = activation(&stored.state, &effect.context.work)?;
        if activation_id.is_some_and(|id| id != row.get::<&str, _>("activation_id"))
            || a.work_state != "uncertain"
            || a.admitted_epoch.as_deref() != Some(effect.context.owner.owner_epoch.as_str())
            || stored.state.epoch == effect.context.owner.owner_epoch
            || !matches!(
                a.stop_state,
                EngineStopState::Requested { .. } | EngineStopState::Uncertain { .. }
            )
            || !process_dead(row.get("process_id"))
        {
            continue;
        }
        // Process termination proves no local executor can continue. It does not
        // prove whether a workspace mutation happened before that termination.
        let evidence = serde_json::json!({"kind":"macro-native-process-exit/1", "status":"ended", "failed":true, "outcomeUnknown":true}).to_string();
        let settlement = EngineSettlement {
            context: effect.context.clone(),
            effect: effect.effect.clone(),
            status: "ended".into(),
            evidence_json: evidence,
        };
        let result = if matches!(effect.effect, EngineEffectIdentity::Tool { .. }) {
            Some(encode(&"Tool result unavailable after native process exit. Inspect the workspace before starting another execution.")?)
        } else {
            None
        };
        sqlx::query("UPDATE engine_effects SET status='ended',settlement_json=?,result_json=? WHERE system_id=? AND effect_key=?")
            .bind(encode(&settlement)?).bind(result).bind(system_id).bind(effect_key(&effect.effect)?).execute(&mut *tx).await?;
        event(
            &mut tx,
            &mut stored.state,
            system_id,
            Some(effect.context.work),
            "diagnostic",
            "{\"code\":\"RECOVERY_RESULT_LOST\"}".into(),
        )
        .await?;
    }
    save(&mut tx, system_id, &stored.state).await?;
    tx.commit().await?;
    confirm_stopped_retired_work(pool, system_id).await
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn process_absence_is_not_inferred_from_missing_receipts() {
        assert!(!process_dead(i64::from(std::process::id())));
        assert!(!process_dead(0));
        assert!(!process_dead(-1));
        assert!(!process_dead(i64::MAX));
        let mut child =
            crate::core::process::background_command(if cfg!(windows) { "cmd" } else { "sh" });
        if cfg!(windows) {
            child.args(["/C", "exit", "0"]);
        } else {
            child.args(["-c", "exit 0"]);
        }
        let mut child = child.spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(process_dead(i64::from(pid)));
    }
}
