import * as assert from 'assert';

// INTENTIONALLY FAILING — CI red canary. DO NOT MERGE.
// Verifies that a failing e2e test turns the `VSCode integration tests` (e2e) job
// red now that continue-on-error was removed. Deleted after observation.
describe('CI red canary (e2e)', () => {
  it('fails on purpose to prove the e2e job gates', () => {
    assert.strictEqual(1, 2);
  });
});
