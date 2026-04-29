const crypto = require('crypto');

function generateServerSeed() {
  return crypto.randomBytes(32).toString('hex');
}

// Commit to a server seed before the round — revealed after crash for verification
function hashServerSeed(serverSeed) {
  return crypto.createHash('sha256').update(serverSeed).digest('hex');
}

/**
 * Crash point derivation — provably fair.
 *
 * Uses HMAC-SHA256(serverSeed, roundId) to produce a deterministic hash.
 * Takes the first 52 bits of that hash as a uniform integer h in [0, 2^52).
 *
 * House edge (1%): if h % 100 === 0, instant crash at 1.00x.
 * Otherwise: crashPoint = floor(2^52 / (2^52 - h)) / 100
 *   → P(C > c) = 1/c, giving a Pareto distribution.
 *   → Expected RTP = 99% (1% house edge).
 *
 * Players can verify post-round:
 *   1. SHA256(serverSeed) === serverSeedHash  ✓
 *   2. Recompute crash with revealed serverSeed and roundId  ✓
 */
function calculateCrashPoint(serverSeed, roundId) {
  const hmac = crypto.createHmac('sha256', serverSeed);
  hmac.update(String(roundId));
  const hash = hmac.digest('hex');

  // 13 hex chars = 52 bits, giving enough precision without floating point issues
  const e = 2 ** 52;
  const h = parseInt(hash.slice(0, 13), 16);

  if (h % 100 === 0) return 1.00;

  // P(C > c) = 1/c  →  crash = floor(100 * e / (e - h)) / 100
  const raw = Math.floor(100 * e / (e - h)) / 100;
  return Math.max(1.00, raw);
}

/**
 * Verify a past round given the revealed server seed.
 * Returns true if hash and crash point are consistent.
 */
function verifyRound(serverSeed, serverSeedHash, roundId, claimedCrashPoint) {
  const expectedHash = hashServerSeed(serverSeed);
  if (expectedHash !== serverSeedHash) return false;
  const computed = calculateCrashPoint(serverSeed, roundId);
  return Math.abs(computed - claimedCrashPoint) < 0.001;
}

module.exports = { generateServerSeed, hashServerSeed, calculateCrashPoint, verifyRound };
