use macro_lib::core::process::{background_contained_tokio_command, ContainedBackgroundProcess};

#[cfg(unix)]
mod unix_tests {
    use super::*;
    use macro_lib::core::process::background_tokio_command;
    use std::process::Stdio;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::time::{Duration, Instant};

    const DESCENDANT_BASE_SLEEP_SECONDS: u64 = 987_654_300;

    fn next_unique_sleep_seconds() -> u64 {
        static COUNTER: AtomicU32 = AtomicU32::new(0);
        DESCENDANT_BASE_SLEEP_SECONDS + COUNTER.fetch_add(1, Ordering::Relaxed) as u64
    }

    fn descendant_survives(pattern: &str) -> bool {
        std::process::Command::new("pgrep")
            .arg("-f")
            .arg(pattern)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map(|status| status.success())
            .unwrap_or(false)
    }

    fn observed_pgid(pid: u32) -> Option<i64> {
        let output = std::process::Command::new("ps")
            .args(["-o", "pgid=", "-p", &pid.to_string()])
            .output()
            .ok()?;
        String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<i64>()
            .ok()
    }

    async fn poll_until(condition: impl Fn() -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while !condition() {
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        true
    }

    struct ShellFixture {
        contained: ContainedBackgroundProcess,
        descendant_pattern: String,
    }

    async fn spawn_shell_with_descendant() -> ShellFixture {
        let seconds = next_unique_sleep_seconds();
        let mut command = background_contained_tokio_command("sh");
        command.args(["-c", &format!("sleep {seconds} & wait")]);
        let contained = ContainedBackgroundProcess::spawn(command).expect("spawn contained shell");
        let descendant_pattern = format!("sleep {seconds}");
        assert!(
            poll_until(
                || descendant_survives(&descendant_pattern),
                Duration::from_secs(3)
            )
            .await,
            "descendant process never appeared",
        );
        ShellFixture {
            contained,
            descendant_pattern,
        }
    }

    #[tokio::test]
    async fn spawn_creates_dedicated_process_group() {
        let mut fixture = spawn_shell_with_descendant().await;
        let pid = fixture.contained.id().expect("child pid");
        assert_eq!(observed_pgid(pid), Some(pid as i64));
        fixture
            .contained
            .terminate_bounded()
            .await
            .expect("terminate");
    }

    #[tokio::test]
    async fn terminate_bounded_kills_descendants() {
        let mut fixture = spawn_shell_with_descendant().await;
        let status = fixture
            .contained
            .terminate_with_grace(Duration::from_millis(700))
            .await
            .expect("bounded termination");
        assert!(!status.success());
        assert!(
            poll_until(
                || !descendant_survives(&fixture.descendant_pattern),
                Duration::from_secs(5)
            )
            .await,
            "descendant survived bounded termination",
        );
        let reapplied = fixture.contained.wait().await.expect("cached status");
        assert_eq!(reapplied.code(), status.code());
    }

    #[tokio::test]
    async fn zero_grace_immediately_kills_group() {
        let mut fixture = spawn_shell_with_descendant().await;
        let status = fixture
            .contained
            .terminate_with_grace(Duration::ZERO)
            .await
            .expect("immediate termination");
        assert!(!status.success());
        assert!(
            poll_until(
                || !descendant_survives(&fixture.descendant_pattern),
                Duration::from_secs(5)
            )
            .await,
            "descendant survived immediate group kill",
        );
    }

    #[tokio::test]
    async fn dropping_contained_process_kills_descendants() {
        let fixture = spawn_shell_with_descendant().await;
        let descendant_pattern = fixture.descendant_pattern;
        drop(fixture.contained);
        assert!(
            poll_until(
                || !descendant_survives(&descendant_pattern),
                Duration::from_secs(5)
            )
            .await,
            "descendant survived kill-on-drop",
        );
    }

    #[tokio::test]
    async fn terminate_bounded_after_exit_returns_status() {
        let mut command = background_tokio_command("sh");
        command.args(["-c", "exit 0"]);
        let mut contained = ContainedBackgroundProcess::spawn(command).expect("spawn");
        let first = contained.wait().await.expect("wait");
        assert!(first.success());
        let second = contained.terminate_bounded().await.expect("terminate");
        assert!(second.success());
    }

    #[tokio::test]
    async fn terminate_kills_descendant_after_group_leader_exits() {
        let seconds = next_unique_sleep_seconds();
        let descendant_pattern = format!("sleep {seconds}");
        let mut command = background_contained_tokio_command("sh");
        command.args([
            "-c",
            &format!("sh -c \"trap '' TERM; sleep {seconds}\" & exit 0"),
        ]);
        let mut contained = ContainedBackgroundProcess::spawn(command).expect("spawn");
        assert!(
            poll_until(
                || descendant_survives(&descendant_pattern),
                Duration::from_secs(3)
            )
            .await,
            "detached descendant process never appeared",
        );
        let leader_status = contained.wait().await.expect("wait for group leader");
        assert!(leader_status.success());

        contained
            .terminate_with_grace(Duration::from_millis(100))
            .await
            .expect("terminate remaining group");
        assert!(
            poll_until(
                || !descendant_survives(&descendant_pattern),
                Duration::from_secs(5)
            )
            .await,
            "descendant survived after its group leader exited",
        );
    }
}

#[cfg(windows)]
mod windows_tests {
    use super::*;
    use std::process::Stdio;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};

    fn serialization_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| Mutex::new(())).lock().unwrap()
    }

    fn image_running(image: &str) -> bool {
        std::process::Command::new("tasklist")
            .args(["/FI", &format!("IMAGENAME eq {image}"), "/NH"])
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
            .map(|output| {
                String::from_utf8_lossy(&output.stdout)
                    .to_ascii_lowercase()
                    .contains(image)
            })
            .unwrap_or(false)
    }

    async fn poll_until(condition: impl Fn() -> bool, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while !condition() {
            if Instant::now() >= deadline {
                return false;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        true
    }

    async fn spawn_cmd_with_descendant() -> ContainedBackgroundProcess {
        let mut command = background_contained_tokio_command("cmd");
        command.args(["/C", "ping -n 300 127.0.0.1"]);
        let contained = ContainedBackgroundProcess::spawn(command).expect("spawn contained cmd");
        assert!(
            poll_until(|| image_running("ping.exe"), Duration::from_secs(10)).await,
            "descendant ping.exe never appeared",
        );
        contained
    }

    #[tokio::test]
    async fn job_object_termination_kills_descendants() {
        let _serial = serialization_lock();
        let mut contained = spawn_cmd_with_descendant().await;
        let status = contained.terminate_bounded().await.expect("terminate");
        assert!(!status.success());
        assert!(
            poll_until(|| !image_running("ping.exe"), Duration::from_secs(5)).await,
            "descendant survived job object termination",
        );
    }

    #[tokio::test]
    async fn dropping_contained_process_kills_job_tree() {
        let _serial = serialization_lock();
        let contained = spawn_cmd_with_descendant().await;
        drop(contained);
        assert!(
            poll_until(|| !image_running("ping.exe"), Duration::from_secs(5)).await,
            "descendant survived kill-on-drop via job close",
        );
    }

    #[tokio::test]
    async fn job_termination_kills_descendant_after_leader_exits() {
        let _serial = serialization_lock();
        let mut command = background_contained_tokio_command("cmd");
        command.args(["/C", "start \"\" /B ping -n 300 127.0.0.1"]);
        let mut contained =
            ContainedBackgroundProcess::spawn(command).expect("spawn contained cmd");
        assert!(
            poll_until(|| image_running("ping.exe"), Duration::from_secs(10)).await,
            "detached ping.exe never appeared",
        );
        let leader_status = contained.wait().await.expect("wait for cmd leader");
        assert!(leader_status.success());

        contained.terminate_bounded().await.expect("terminate job");
        assert!(
            poll_until(|| !image_running("ping.exe"), Duration::from_secs(5)).await,
            "descendant survived after job leader exited",
        );
    }
}
