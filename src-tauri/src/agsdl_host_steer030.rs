//! In-process delivery to an exact owned agent attempt. Receiving a message
//! outside that parent cannot mint a consumption acknowledgment.
use crate::{
    agsdl_host_flow030::FlowWorkAttempt030,
    ai::stream_tasks::StreamTasks,
    db::agsdl_execution::{
        failure,
        flow030::{FlowEffect030, FlowEffectKind030},
        Result,
    },
};
use tokio::sync::{mpsc, oneshot};

#[derive(Clone)]
pub(crate) struct SteerSender030(mpsc::Sender<SteerDelivery030>);
pub(crate) struct SteerInbox030(mpsc::Receiver<SteerDelivery030>);

pub(crate) fn channel030() -> (SteerSender030, SteerInbox030) {
    let (send, recv) = mpsc::channel(1);
    (SteerSender030(send), SteerInbox030(recv))
}

fn refused() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "CORRELATION",
        "steer",
        "Steer recipient differs from the owned work",
    )
}
fn uncertain() -> crate::db::agsdl_execution::dto::EngineFailure {
    failure(
        "UNCERTAIN",
        "steer",
        "Steer consumption was not acknowledged",
    )
}

fn matches_attempt(effect: &FlowEffect030, attempt: &FlowWorkAttempt030) -> bool {
    matches!(&effect.kind, FlowEffectKind030::Steer { work, .. }
        if effect.identity == *attempt.identity()
        && work.activation_id == attempt.work().activation_id
        && work.start_effect_id == attempt.start_effect_id()
        && work.agent_instance_id == attempt.work().agent_instance_id)
}

pub(crate) struct SteerDelivery030 {
    effect: FlowEffect030,
    attempt: FlowWorkAttempt030,
    ack: oneshot::Sender<ConsumedSteer030>,
}

/// Sealed evidence from the owned consumer, never deserialized from IPC.
pub(crate) struct ConsumedSteer030 {
    effect: FlowEffect030,
    attempt: FlowWorkAttempt030,
    consumed: bool,
}
impl ConsumedSteer030 {
    pub(crate) fn consumed(&self) -> bool {
        self.consumed
    }
    pub(crate) fn verifies(&self, effect: &FlowEffect030, attempt: &FlowWorkAttempt030) -> bool {
        self.effect == *effect
            && self.attempt.provider_attempt_id() == attempt.provider_attempt_id()
            && self.attempt.owner() == attempt.owner()
            && self.attempt.generation() == attempt.generation()
            && matches_attempt(effect, attempt)
    }
}
impl SteerSender030 {
    pub(crate) fn is_closed(&self) -> bool {
        self.0.is_closed()
    }
    pub(crate) async fn deliver(
        &self,
        effect: &FlowEffect030,
        attempt: &FlowWorkAttempt030,
    ) -> Result<ConsumedSteer030> {
        if !matches_attempt(effect, attempt) {
            return Err(refused());
        }
        let (ack, result) = oneshot::channel();
        if self
            .0
            .send(SteerDelivery030 {
                effect: effect.clone(),
                attempt: attempt.clone(),
                ack,
            })
            .await
            .is_err()
        {
            return Ok(ConsumedSteer030 {
                effect: effect.clone(),
                attempt: attempt.clone(),
                consumed: false,
            });
        }
        result.await.map_err(|_| uncertain())
    }
}
impl SteerInbox030 {
    pub(crate) fn close(&mut self) {
        self.0.close();
    }
    pub(crate) async fn receive(&mut self) -> Option<SteerDelivery030> {
        self.0.recv().await
    }
}
impl SteerDelivery030 {
    pub(crate) fn effect(&self) -> &FlowEffect030 {
        &self.effect
    }

    /// Call only after the transport has consumed the message and sender.
    pub(crate) fn acknowledge(
        self,
        tasks: &StreamTasks,
        attempt: &FlowWorkAttempt030,
    ) -> Result<()> {
        self.resolve(tasks, attempt, true)
    }

    /// Only before any provider send, or after an explicit provider rejection.
    pub(crate) fn not_sent(self, tasks: &StreamTasks, attempt: &FlowWorkAttempt030) -> Result<()> {
        self.resolve(tasks, attempt, false)
    }
    fn resolve(
        self,
        tasks: &StreamTasks,
        attempt: &FlowWorkAttempt030,
        consumed: bool,
    ) -> Result<()> {
        if !matches_attempt(&self.effect, attempt)
            || self.attempt.provider_attempt_id() != attempt.provider_attempt_id()
            || self.attempt.owner() != attempt.owner()
            || self.attempt.generation() != attempt.generation()
        {
            return Err(refused());
        }
        let request = format!(
            "flow030:{}:{}",
            attempt.identity().system_start_id,
            attempt.start_effect_id()
        );
        tasks
            .verify_agent_scope030(&request, attempt)
            .map_err(|_| refused())?;
        self.ack
            .send(ConsumedSteer030 {
                effect: self.effect,
                attempt: self.attempt,
                consumed,
            })
            .map_err(|_| uncertain())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::agsdl_execution::flow030::WorkRef030;

    fn effect(attempt: &FlowWorkAttempt030) -> FlowEffect030 {
        FlowEffect030 {
            id: "steer-effect".into(),
            identity: attempt.identity().clone(),
            revision: "2".into(),
            kind: FlowEffectKind030::Steer {
                work: WorkRef030 {
                    activation_id: attempt.work().activation_id.clone(),
                    start_effect_id: attempt.start_effect_id().into(),
                    agent_instance_id: attempt.work().agent_instance_id.clone(),
                },
                delivery_activation_id: "nudge".into(),
                message_json: "{\"prompt\":\"Update the changelog.\"}".into(),
                occurrence: None,
                sender: None,
            },
        }
    }

    #[tokio::test]
    async fn only_exact_owned_consumer_can_acknowledge_delivery() {
        for mode in 0..3 {
            let attempt = FlowWorkAttempt030::registry_fixture030("attempt");
            let fx = effect(&attempt);
            let (send, mut inbox) = channel030();
            let tasks = StreamTasks::default();
            let target = attempt.clone();
            let registry = tasks.clone();
            let request = format!(
                "flow030:{}:{}",
                attempt.identity().system_start_id,
                attempt.start_effect_id()
            );
            let (done, consumed) = oneshot::channel();
            tasks
                .start_agent030(request.clone(), &attempt, async move {
                    let delivery = inbox.receive().await.unwrap();
                    assert!(matches!(&delivery.effect().kind,
                    FlowEffectKind030::Steer { message_json, delivery_activation_id, .. }
                    if message_json.contains("changelog") && delivery_activation_id == "nudge"));
                    if mode == 2 {
                        drop(delivery);
                        let _ = done.send(());
                        return;
                    }
                    let foreign = FlowWorkAttempt030::registry_fixture030("foreign");
                    let result =
                        delivery.acknowledge(&registry, if mode == 0 { &target } else { &foreign });
                    assert_eq!(result.is_ok(), mode == 0);
                    let _ = done.send(());
                })
                .unwrap();
            let result = send.deliver(&fx, &attempt).await;
            assert_eq!(result.is_ok(), mode == 0);
            if let Ok(receipt) = result {
                assert!(receipt.verifies(&fx, &attempt));
            }
            consumed.await.unwrap();
            tasks.join_agent030(&attempt, false).await.unwrap();
        }
    }

    #[tokio::test]
    async fn receiving_outside_owned_scope_never_proves_consumption() {
        let attempt = FlowWorkAttempt030::registry_fixture030("attempt");
        let fx = effect(&attempt);
        let (send, mut inbox) = channel030();
        let (sent, received) = tokio::join!(send.deliver(&fx, &attempt), async {
            inbox
                .receive()
                .await
                .unwrap()
                .acknowledge(&StreamTasks::default(), &attempt)
        });
        assert!(sent.is_err());
        assert!(received.is_err());
    }

    #[tokio::test]
    async fn foreign_work_and_closed_recipient_are_refused_without_acknowledgment() {
        let attempt = FlowWorkAttempt030::registry_fixture030("attempt");
        let mut fx = effect(&attempt);
        let (send, inbox) = channel030();
        fx.identity.epoch = "foreign".into();
        assert_eq!(
            send.deliver(&fx, &attempt).await.err().unwrap().code,
            "CORRELATION"
        );
        drop(inbox);
        assert!(!send
            .deliver(&effect(&attempt), &attempt)
            .await
            .unwrap()
            .consumed());
    }
}
