// Returns authoritative server time and key cutoff moments.
// Used by frontend pages to drive countdowns/gates without trusting the
// user's device clock (which can be changed in iOS Settings to bypass gates).

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store, max-age=0',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  // Mindanao dorm unlock: May 3, 2026 at 12:01 AM Philippine Time (UTC+8)
  // = May 2, 2026 at 16:01 UTC
  const MINDANAO_DORM_UNLOCK_AT = Date.UTC(2026, 4, 2, 16, 1, 0); // month is 0-indexed

  // Registration close: end of May 20, 2026 Philippine Time (11:59 PM PHT, UTC+8)
  // = May 20, 2026 at 15:59 UTC. After this, registration is closed.
  const REGISTRATION_CLOSE_AT = Date.UTC(2026, 4, 20, 15, 59, 59);

  // Accommodation reservations close: end of May 22, 2026 Philippine Time
  // (11:59 PM PHT, UTC+8) = May 22, 2026 at 15:59 UTC. Covers dorms, camping,
  // AND tents. After this, no new accommodation/tent reservations are accepted.
  const ACCOMMODATION_CLOSE_AT = Date.UTC(2026, 4, 22, 15, 59, 59);

  const now = Date.now();

  return {
    statusCode: 200,
    headers,
    body: JSON.stringify({
      now: now,
      mindanaoDormUnlockAt: MINDANAO_DORM_UNLOCK_AT,
      mindanaoDormUnlocked: now >= MINDANAO_DORM_UNLOCK_AT,
      registrationCloseAt: REGISTRATION_CLOSE_AT,
      registrationClosed: now >= REGISTRATION_CLOSE_AT,
      accommodationCloseAt: ACCOMMODATION_CLOSE_AT,
      accommodationClosed: now >= ACCOMMODATION_CLOSE_AT
    })
  };
};
