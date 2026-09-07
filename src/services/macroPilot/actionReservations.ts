const taskReservations = new Map<string, symbol>();
const conversationReservations = new Map<string, symbol>();

export interface PilotActionReservation {
  readonly token: symbol;
  readonly taskId?: string;
  readonly conversationId?: string;
  reserveConversation(conversationId: string): void;
  release(): void;
}

export const reservePilotAction = (params: {
  taskId?: string;
  conversationId?: string;
}): PilotActionReservation => {
  if (params.taskId && taskReservations.has(params.taskId)) {
    throw new Error('A Pilot action is already running for this task.');
  }
  if (params.conversationId && conversationReservations.has(params.conversationId)) {
    throw new Error('A Pilot action is already running for this conversation.');
  }

  const token = Symbol('pilot-action');
  if (params.taskId) taskReservations.set(params.taskId, token);
  if (params.conversationId) conversationReservations.set(params.conversationId, token);
  let released = false;

  let conversationId = params.conversationId;
  return {
    token,
    taskId: params.taskId,
    get conversationId() {
      return conversationId;
    },
    reserveConversation: (nextConversationId) => {
      if (released) throw new Error('The Pilot action reservation expired.');
      const current = conversationReservations.get(nextConversationId);
      if (current && current !== token) {
        throw new Error('A Pilot action is already running for this conversation.');
      }
      if (conversationId && conversationId !== nextConversationId) {
        throw new Error('The Pilot action already targets another conversation.');
      }
      conversationId = nextConversationId;
      conversationReservations.set(nextConversationId, token);
    },
    release: () => {
      if (released) return;
      released = true;
      if (params.taskId && taskReservations.get(params.taskId) === token) {
        taskReservations.delete(params.taskId);
      }
      if (
        conversationId &&
        conversationReservations.get(conversationId) === token
      ) {
        conversationReservations.delete(conversationId);
      }
    },
  };
};

export const assertPilotTaskActionAllowed = (
  taskId: string,
  token?: symbol,
): void => {
  const reservation = taskReservations.get(taskId);
  if (reservation && reservation !== token) {
    throw new Error('This task is being changed from Macro Pilot.');
  }
};

export const assertPilotConversationActionAllowed = (
  conversationId: string,
  token?: symbol,
): void => {
  const reservation = conversationReservations.get(conversationId);
  if (reservation && reservation !== token) {
    throw new Error('This conversation is being changed from Macro Pilot.');
  }
};

export const assertPilotReservationCurrent = (
  reservation: PilotActionReservation,
): void => {
  if (
    (reservation.taskId && taskReservations.get(reservation.taskId) !== reservation.token) ||
    (reservation.conversationId &&
      conversationReservations.get(reservation.conversationId) !== reservation.token)
  ) {
    throw new Error('The Pilot action reservation expired.');
  }
};
