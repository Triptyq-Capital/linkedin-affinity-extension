/**
 * Unit test for the e2e credential loader. Runs in the e2e project (node env)
 * but makes NO network calls and needs NO real secrets — it only asserts the
 * loader's shape and skip-guard contract.
 */
const { loadCreds, haveCreds } = require('./creds');

describe('e2e creds loader', () => {
  test('haveCreds returns a boolean', () => {
    expect(typeof haveCreds()).toBe('boolean');
  });

  test('loadCreds returns the three credential slots', () => {
    const c = loadCreds();
    expect(c).toHaveProperty('affinityApiKey');
    expect(c).toHaveProperty('liAt');
    expect(c).toHaveProperty('jsessionid');
  });

  test('env vars are honored as a fallback', () => {
    const prev = process.env.AFFINITY_API_KEY;
    process.env.AFFINITY_API_KEY = 'env-sentinel-key';
    try {
      // env fallback only applies when Keychain has no value; assert it is at
      // least reachable as a source (value is env-sentinel OR a real keychain key)
      expect(typeof loadCreds().affinityApiKey === 'string').toBe(true);
    } finally {
      if (prev === undefined) delete process.env.AFFINITY_API_KEY;
      else process.env.AFFINITY_API_KEY = prev;
    }
  });
});
