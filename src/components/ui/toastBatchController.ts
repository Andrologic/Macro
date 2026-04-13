type ToastId = string | number;
type ToastBatchSubscriber = () => void;
type ToastBatchExpiryHandler = (toastIds: ToastId[]) => void;
type TimerHandle = ReturnType<typeof setTimeout>;

interface ToastBatchScheduler {
  now: () => number;
  setTimeout: (callback: () => void, delayMs: number) => TimerHandle;
  clearTimeout: (handle: TimerHandle) => void;
}

export interface ActiveToastBatchState {
  activeToastIds: ToastId[];
  deadlineAt: number | null;
  remainingMs: number | null;
  isPaused: boolean;
}

export const TOAST_BATCH_DURATION_MS = 5000;

const DEFAULT_SCHEDULER: ToastBatchScheduler = {
  now: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};

export class ToastBatchController {
  private activeToastIds: ToastId[] = [];
  private deadlineAt: number | null = null;
  private remainingMs: number | null = null;
  private isPaused = false;
  private timeoutHandle: TimerHandle | null = null;
  private readonly subscribers = new Set<ToastBatchSubscriber>();
  private expiryHandler: ToastBatchExpiryHandler | null = null;
  private snapshot: ActiveToastBatchState = {
    activeToastIds: [],
    deadlineAt: null,
    remainingMs: null,
    isPaused: false,
  };

  constructor(
    private readonly durationMs: number = TOAST_BATCH_DURATION_MS,
    private readonly scheduler: ToastBatchScheduler = DEFAULT_SCHEDULER
  ) {}

  getSnapshot = (): ActiveToastBatchState => this.snapshot;

  subscribe = (subscriber: ToastBatchSubscriber): (() => void) => {
    this.subscribers.add(subscriber);
    return () => {
      this.subscribers.delete(subscriber);
    };
  };

  setExpiryHandler = (handler: ToastBatchExpiryHandler | null): void => {
    this.expiryHandler = handler;
  };

  registerToast = (toastId: ToastId): void => {
    const nextToastIds = this.activeToastIds.filter((currentToastId) => currentToastId !== toastId);
    nextToastIds.push(toastId);
    this.activeToastIds = nextToastIds;
    this.resetBatchDeadline();
  };

  unregisterToast = (toastId: ToastId): void => {
    const nextToastIds = this.activeToastIds.filter((currentToastId) => currentToastId !== toastId);
    if (nextToastIds.length === this.activeToastIds.length) {
      return;
    }

    this.activeToastIds = nextToastIds;
    if (this.activeToastIds.length === 0) {
      this.cancelTimer();
      this.deadlineAt = null;
      this.remainingMs = null;
      this.isPaused = false;
    }
    this.emitChange();
  };

  resetBatchDeadline = (): void => {
    if (this.activeToastIds.length === 0) {
      this.clearBatch();
      return;
    }

    this.remainingMs = this.durationMs;
    if (this.isPaused) {
      this.deadlineAt = null;
      this.cancelTimer();
      this.emitChange();
      return;
    }

    this.deadlineAt = this.scheduler.now() + this.durationMs;
    this.scheduleExpiry(this.durationMs);
    this.emitChange();
  };

  pauseBatchTimer = (): void => {
    if (this.isPaused || this.activeToastIds.length === 0) {
      return;
    }

    const now = this.scheduler.now();
    this.remainingMs =
      this.deadlineAt === null
        ? this.durationMs
        : Math.max(0, this.deadlineAt - now);
    this.deadlineAt = null;
    this.isPaused = true;
    this.cancelTimer();
    this.emitChange();
  };

  resumeBatchTimer = (): void => {
    if (!this.isPaused || this.activeToastIds.length === 0) {
      return;
    }

    const delayMs = Math.max(0, this.remainingMs ?? this.durationMs);
    this.isPaused = false;
    this.deadlineAt = this.scheduler.now() + delayMs;
    this.scheduleExpiry(delayMs);
    this.emitChange();
  };

  clearBatch = (): void => {
    this.cancelTimer();
    this.activeToastIds = [];
    this.deadlineAt = null;
    this.remainingMs = null;
    this.isPaused = false;
    this.emitChange();
  };

  private scheduleExpiry(delayMs: number): void {
    this.cancelTimer();
    this.timeoutHandle = this.scheduler.setTimeout(() => {
      this.timeoutHandle = null;
      this.expireBatch();
    }, delayMs);
  }

  private expireBatch(): void {
    if (this.activeToastIds.length === 0) {
      this.clearBatch();
      return;
    }

    const expiredToastIds = [...this.activeToastIds];
    this.activeToastIds = [];
    this.deadlineAt = null;
    this.remainingMs = null;
    this.isPaused = false;
    this.emitChange();
    this.expiryHandler?.(expiredToastIds);
  }

  private cancelTimer(): void {
    if (this.timeoutHandle === null) {
      return;
    }

    this.scheduler.clearTimeout(this.timeoutHandle);
    this.timeoutHandle = null;
  }

  private emitChange(): void {
    this.snapshot = {
      activeToastIds: [...this.activeToastIds],
      deadlineAt: this.deadlineAt,
      remainingMs: this.remainingMs,
      isPaused: this.isPaused,
    };
    this.subscribers.forEach((subscriber) => subscriber());
  }
}

const toastBatchController = new ToastBatchController();

export const subscribeToToastBatch = toastBatchController.subscribe;
export const getToastBatchSnapshot = toastBatchController.getSnapshot;
export const setToastBatchExpiryHandler = toastBatchController.setExpiryHandler;
export const registerToastInBatch = toastBatchController.registerToast;
export const unregisterToastFromBatch = toastBatchController.unregisterToast;
export const resetToastBatchDeadline = toastBatchController.resetBatchDeadline;
export const pauseToastBatchTimer = toastBatchController.pauseBatchTimer;
export const resumeToastBatchTimer = toastBatchController.resumeBatchTimer;
export const clearToastBatch = toastBatchController.clearBatch;

export const __testables = {
  DEFAULT_SCHEDULER,
  toastBatchController,
};
