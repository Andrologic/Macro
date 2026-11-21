import { validateG as inheritedValidateG } from '../../../experimental/modular-candidate-1/readers/javascript/graph.mjs';
import { contract, validateD } from './core.mjs';

export const validateG = (primary, operation, inventory) =>
  inheritedValidateG(primary, operation, inventory, { contract, validateD });
