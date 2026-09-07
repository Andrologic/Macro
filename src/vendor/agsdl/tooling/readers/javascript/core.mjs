export * from '../../../experimental/readers/javascript/core.mjs';
import { validateD as inheritedValidateD } from '../../../experimental/readers/javascript/core.mjs';

export const contract = 'agsdl-0.1.0';
export const processor = Object.freeze({
  identity: 'agsdl/reference-javascript-reader',
  version: '0.1.0',
});
export const validateD = context => inheritedValidateD(context, contract);
