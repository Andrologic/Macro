# AGENT Instructions

## Notifications

- Use `notify.*` from `src/components/ui/toastService` for every user-facing notification emitted by feature code.
- Use `notify.info`, `notify.success`, `notify.warning`, or `notify.error` for informational notifications that do not ask the user to choose or retry something.
- Use `notify.actionRequired` when a notification presents a decision, retry, or follow-up action. Keep it to at most two actions.
- Do not call `toast.success`, `toast.info`, `toast.warning`, or `toast.error` directly outside the notification infrastructure module and its tests.
- Do not build notification JSX locally in feature code. Reuse the shared templates in `src/components/ui/notifications/*`.
- Do not introduce inline styles or one-off visual variants for notifications. Extend the shared notification system instead.
- When desktop title or body needs an override, pass it through the shared helper inputs instead of inventing a local payload shape.
