//! Recovery requires an observed unlock and an active console session. Screen
//! wake alone is not evidence of authentication and never grants access.
#[derive(Default)]
pub(super) struct SessionGate {
    pub awake: bool,
    pub active: bool,
    pub unlocked: bool,
}
impl SessionGate {
    pub fn can_recover(&self) -> bool {
        self.awake && self.active && self.unlocked
    }
    pub fn sleep(&mut self) {
        self.awake = false;
        self.unlocked = false;
    }
    pub fn resign(&mut self) {
        self.active = false;
        self.unlocked = false;
    }
    pub fn lock(&mut self) {
        self.unlocked = false;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_requires_unlock_and_active_awake_session_in_any_order() {
        let mut gate = SessionGate {
            awake: true,
            ..Default::default()
        };
        gate.active = true;
        assert!(!gate.can_recover());
        gate.unlocked = true;
        assert!(gate.can_recover());
        gate.lock();
        assert!(!gate.can_recover());
        gate.unlocked = true;
        gate.resign();
        gate.active = true;
        assert!(!gate.can_recover());
        gate.sleep();
        gate.unlocked = true;
        assert!(!gate.can_recover());
        gate.awake = true;
        assert!(gate.can_recover());
        gate.sleep();
        gate.awake = true;
        assert!(!gate.can_recover());
    }
}
