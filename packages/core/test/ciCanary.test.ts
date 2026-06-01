import { describe, it, expect } from 'vitest';

// INTENTIONALLY FAILING — CI red canary. DO NOT MERGE.
// Exists only to verify that a failing unit test turns the `checks` (pre-commit
// vitest hook) and `unit` (test:coverage) jobs red. Deleted after observation.
describe('CI red canary (unit)', () => {
  it('fails on purpose to prove the unit/coverage job gates', () => {
    expect(1).toBe(2);
  });
});
