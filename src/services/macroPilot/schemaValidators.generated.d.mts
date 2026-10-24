import type { ValidateFunction } from 'ajv';
export const schemaValidate: ValidateFunction;
export const resultValidate: ValidateFunction;
export const deliveryValidate: ValidateFunction;
export function clearErrors(): void;
export function diagnosticsEmpty(): boolean;
export const diagnosticSlots: number;
