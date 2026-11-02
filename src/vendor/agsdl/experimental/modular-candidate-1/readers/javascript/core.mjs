export * from '../../../readers/javascript/core.mjs';
import { validateD as inheritedValidateD } from '../../../readers/javascript/core.mjs';

export const contract = 'proposal-0013-candidate-1';
export const validateD = ctx => inheritedValidateD(ctx, contract);
