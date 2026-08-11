/**
 * E2E credential loader — Keychain first, environment fallback.
 *
 * Reads the same Keychain services the sanctum-crm ingester uses, so there is a
 * single source of truth and nothing is ever pasted into a file or committed:
 *   - affinity-api-key   (Affinity v1 Basic auth)
 *   - linkedin-li-at     (Voyager session)
 *   - linkedin-jsessionid(Voyager CSRF)
 *
 * Credential VALUES are never logged. If Keychain has no entry, the matching
 * environment variable is used (for CI). haveCreds() gates the e2e suite so it
 * SKIPS (never fails) when nothing is provisioned.
 */
const { execFileSync } = require('child_process');

function keychain(service) {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-w', '-s', service, '-a', 'sanctum'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim();
  } catch {
    return '';
  }
}

function loadCreds() {
  return {
    affinityApiKey: keychain('affinity-api-key') || process.env.AFFINITY_API_KEY || '',
    liAt: keychain('linkedin-li-at') || process.env.LINKEDIN_LI_AT || '',
    jsessionid: keychain('linkedin-jsessionid') || process.env.LINKEDIN_JSESSIONID || '',
  };
}

/** True iff we can talk to Affinity at all (the minimum an e2e run needs). */
function haveCreds() {
  return Boolean(loadCreds().affinityApiKey);
}

module.exports = { loadCreds, haveCreds };
