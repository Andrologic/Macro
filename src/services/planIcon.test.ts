import { expect, test } from 'bun:test';
import { getPlanIcon, normalizePlanIcon } from './planIcon';

test('plan icons accept the offered choices and fall back to the plan kind for legacy or invalid values', () => {
  expect(getPlanIcon({ planKind: 'release', icon: 'shield' })).toBe('shield');
  expect(getPlanIcon({ planKind: 'release' })).toBe('flag');
  expect(getPlanIcon({ planKind: 'hotfix', icon: 'unsupported' })).toBe('zap');
  expect(normalizePlanIcon(null)).toBeUndefined();
});
