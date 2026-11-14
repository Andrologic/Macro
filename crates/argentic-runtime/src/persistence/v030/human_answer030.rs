use serde::{Deserialize, Serialize};
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum HumanAnswer030 {
    Decision {
        decision: String,
        comment: String,
    },
    Approval {
        choice: String,
        comment: String,
    },
    /// The Call adapter must validate the exact answer against its attested
    /// protocol schema before delivering; a JSON object is not that proof.
    Question {
        answer_json: String,
    },
}
