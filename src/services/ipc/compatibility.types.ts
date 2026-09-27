/** Removing or renaming a native field must fail at the adapting boundary. */
export type OmitFields<T, Keys extends keyof T> = Omit<T, Keys>;

/** Keep historical omitted fields without duplicating their native value types. */
export type OptionalFields<T, Keys extends keyof T> = OmitFields<T, Keys> & Partial<Pick<T, Keys>>;
