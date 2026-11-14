#[cfg(feature = "dev-support")]
#[tokio::test]
async fn native_approval_outcomes_attribution_and_policy_guard_lifetime() {
    argentic_runtime::check_approval_boundary().await;
}
