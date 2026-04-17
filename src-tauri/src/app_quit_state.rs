use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

#[derive(Clone, Default)]
pub struct AppQuitState {
    quitting: Arc<AtomicBool>,
}

impl AppQuitState {
    pub fn is_quitting(&self) -> bool {
        self.quitting.load(Ordering::SeqCst)
    }

    pub fn mark_quitting(&self, phase: &'static str) {
        if self.quitting.swap(true, Ordering::SeqCst) {
            tracing::debug!(phase, "App quit state already marked as quitting");
            return;
        }

        tracing::info!(phase, "App quit state marked as quitting");
    }
}

#[cfg(test)]
mod tests {
    use super::AppQuitState;

    #[test]
    fn starts_in_running_state() {
        let state = AppQuitState::default();

        assert!(!state.is_quitting());
    }

    #[test]
    fn remains_quitting_after_the_first_transition() {
        let state = AppQuitState::default();

        state.mark_quitting("close-requested");
        state.mark_quitting("exit-requested");

        assert!(state.is_quitting());
    }
}
