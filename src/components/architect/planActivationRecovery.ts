interface SelectionSnapshot {
  selectionRequestId: number;
}

interface RestoreFailedPlanActivationOptions<
  TAppState,
  TChatState extends SelectionSnapshot,
> {
  previousAppState: TAppState;
  previousChatState: TChatState;
  invalidateConversationResolution: () => void;
  restoreAppState: (state: TAppState) => void;
  getChatSelectionRequestId: () => number;
  restoreChatState: (state: TChatState) => void;
}

interface RecoverFailedPlanActivationOptions<
  TAppState,
  TChatState extends SelectionSnapshot,
> extends RestoreFailedPlanActivationOptions<TAppState, TChatState> {
  error: unknown;
  openReplicaRepair: (error: unknown) => boolean;
  resolveErrorMessage: (error: unknown) => string;
  setError: (message: string) => void;
  notifyError: (message: string) => void;
}

export type FailedPlanActivationRecoveryResult =
  | 'replica-repair-opened'
  | 'error-reported';

export const restoreFailedPlanActivation = <
  TAppState,
  TChatState extends SelectionSnapshot,
>({
  previousAppState,
  previousChatState,
  invalidateConversationResolution,
  restoreAppState,
  getChatSelectionRequestId,
  restoreChatState,
}: RestoreFailedPlanActivationOptions<TAppState, TChatState>): void => {
  invalidateConversationResolution();
  restoreAppState(previousAppState);
  invalidateConversationResolution();
  restoreChatState({
    ...previousChatState,
    selectionRequestId:
      Math.max(
        getChatSelectionRequestId(),
        previousChatState.selectionRequestId,
      ) + 1,
  });
};

export const recoverFailedPlanActivation = <
  TAppState,
  TChatState extends SelectionSnapshot,
>({
  error,
  openReplicaRepair,
  resolveErrorMessage,
  setError,
  notifyError,
  ...restoreOptions
}: RecoverFailedPlanActivationOptions<
  TAppState,
  TChatState
>): FailedPlanActivationRecoveryResult => {
  restoreFailedPlanActivation(restoreOptions);
  if (openReplicaRepair(error)) {
    return 'replica-repair-opened';
  }

  const message = resolveErrorMessage(error);
  setError(message);
  notifyError(message);
  return 'error-reported';
};
