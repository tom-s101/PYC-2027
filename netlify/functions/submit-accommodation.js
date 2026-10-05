const { createClient } = require('@supabase/supabase-js');

// Rate limiting - prevent spam reservations
const submitAttempts = new Map();
const MAX_SUBMITS = 5; // per IP per window
const WINDOW_MS = 10 * 60 * 1000; // 10 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const data = submitAttempts.get(ip);
  if (!data || now - data.windowStart > WINDOW_MS) {
    submitAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  data.count++;
  return data.count > MAX_SUBMITS;
}

// Whitelist of valid accommodation types
const VALID_TYPES = ['girls_dorm', 'boys_dorm', 'camping'];

// Mindanao dorm unlock: May 3, 2026 at 12:01 AM Philippine Time (UTC+8)
// = May 2, 2026 at 16:01 UTC. Before this moment, Mindanao delegates can
// only reserve camping (no dorms). After, no regional restriction.
const MINDANAO_DORM_UNLOCK_AT = Date.UTC(2026, 4, 2, 16, 1, 0);

// Accommodation reservations close: end of May 22, 2026 Philippine Time
// (11:59 PM PHT, UTC+8) = May 22, 2026 at 15:59 UTC. After this, no new
// dorm/camping reservations are accepted (admin-bypass token excepted).
const ACCOMMODATION_CLOSE_AT = Date.UTC(2026, 4, 22, 15, 59, 59);

// Specific PYCs that can override the Mindanao restriction (e.g. delegates
// registered as Mindanao but actually traveling). Match the frontend list.
const MINDANAO_DORM_OVERRIDE = ['PYC-0363', 'PYC-0364'];

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitizeString(str, maxLen) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, maxLen);
}

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    // Rate limit
    const clientIP = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    if (isRateLimited(clientIP)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait before trying again.' }) };
    }

    // Payload size check
    if (event.body && event.body.length > 5000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request too large' }) };
    }

    let data;
    try { data = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    // ===== ACCOMMODATION CUTOFF CHECK =====
    // Reservations close at the end of May 22, 2026 Philippine Time (11:59 PM PHT).
    // Fully server-side (Date.now()), so changing the device clock can't bypass it.
    // Admin-bypass token (ADMIN_REG_BYPASS_TOKEN) is accepted for late reservations.
    if (Date.now() >= ACCOMMODATION_CLOSE_AT) {
      const providedToken = (data.adminBypassToken || '').toString();
      const expectedToken = process.env.ADMIN_REG_BYPASS_TOKEN || '';
      const bypassOk = expectedToken.length > 0 && providedToken === expectedToken;
      if (!bypassOk) {
        return {
          statusCode: 403,
          headers,
          body: JSON.stringify({
            error: 'Accommodation reservations are closed. Reservations ended on May 22, 2026 (Philippine Time). Please contact the PYC team if you need help.',
            accommodationClosed: true
          })
        };
      }
      console.log('Admin bypass used for post-close accommodation reservation');
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Validate and sanitize inputs
    const registrantName = sanitizeString(data.registrantName, 200);
    const registrantEmail = (data.registrantEmail || '').trim().toLowerCase().substring(0, 254);
    const accommodationType = (data.accommodationType || '').trim();
    const registrationId = data.registrationId || null;
    const spots = Math.max(1, Math.min(30, parseInt(data.spotsRequested) || 1)); // Cap at 30

    if (!registrantName || registrantName.length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid name required' }) };
    }
    if (!isValidEmail(registrantEmail)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
    }
    if (!VALID_TYPES.includes(accommodationType)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid accommodation type' }) };
    }

    // Verify registrant has paid or submitted payment proof, and check Mindanao dorm gate
    if (registrationId) {
      const { data: regRecord } = await supabase
        .from('registrations')
        .select('payment_status, region, confirmation_number')
        .eq('id', registrationId)
        .single();

      if (regRecord) {
        const ps = regRecord.payment_status || 'Pending';
        if (ps !== 'Paid' && ps !== 'Pending Review') {
          return { statusCode: 403, headers, body: JSON.stringify({ error: 'You must complete your conference registration payment before reserving accommodations. Current status: ' + ps }) };
        }

        // Mindanao dorm time gate: block dorm reservations from Mindanao delegates
        // until the unlock moment, unless their PYC is on the override list.
        const isDorm = accommodationType === 'girls_dorm' || accommodationType === 'boys_dorm';
        if (isDorm && Date.now() < MINDANAO_DORM_UNLOCK_AT) {
          const region = (regRecord.region || '').toLowerCase();
          const pyc = (regRecord.confirmation_number || '').toUpperCase();
          const hasOverride = MINDANAO_DORM_OVERRIDE.indexOf(pyc) !== -1;
          if (region === 'mindanao' && !hasOverride) {
            return { statusCode: 403, headers, body: JSON.stringify({
              error: 'Dorm reservations for Mindanao delegates open on May 3, 2026 at 12:01 AM (Philippine Time). Until then, you may reserve a tenting space.'
            }) };
          }
        }
      }
    }

    // Check for existing active reservation (prevent double-booking)
    const { data: existingRes } = await supabase
      .from('accommodation_reservations')
      .select('id, accommodation_type, payment_status')
      .eq('registrant_email', registrantEmail)
      .in('payment_status', ['Pending', 'Pending Review', 'Paid']);

    if (existingRes && existingRes.length > 0) {
      return { statusCode: 409, headers, body: JSON.stringify({ error: 'You already have an active accommodation reservation. You cannot reserve again until your current reservation is completed or cancelled.' }) };
    }

    // Check availability
    const { data: avail, error: availError } = await supabase
      .from('accommodation_availability')
      .select('*')
      .eq('id', accommodationType)
      .single();

    if (availError || !avail) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Accommodation type not found' }) };
    }

    if (avail.spots_remaining < spots) {
      return { statusCode: 400, headers, body: JSON.stringify({ 
        error: 'Not enough spots available',
        spotsRemaining: avail.spots_remaining 
      }) };
    }

    // NOTE: Spots are NOT decremented here. They only decrease when payment proof is uploaded.
    // This prevents spots from being "held" by people who reserve but never pay.

    // Round-robin payment account assignment
    let paymentAccount = 'A';
    try {
      const { count } = await supabase
        .from('accommodation_reservations')
        .select('*', { count: 'exact', head: true });
      if (count !== null) {
        paymentAccount = (count % 2 === 0) ? 'A' : 'B';
      }
    } catch (e) {
      console.error('Count error:', e.message);
    }

    const totalAmount = avail.price_per_spot * spots;

    const { data: reservation, error: insertError } = await supabase
      .from('accommodation_reservations')
      .insert([{
        registration_id: registrationId,
        registrant_name: registrantName,
        registrant_email: registrantEmail,
        accommodation_type: accommodationType,
        spots_requested: spots,
        price_per_spot: avail.price_per_spot,
        total_amount: totalAmount,
        payment_status: 'Pending',
        payment_account: paymentAccount
      }])
      .select()
      .single();

    if (insertError) {
      console.error('Insert error:', insertError.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create reservation' }) };
    }


    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        reservationId: reservation.id,
        paymentAccount: paymentAccount,
        totalAmount: totalAmount,
        accommodationType: accommodationType,
        displayName: avail.display_name,
        message: 'Reservation created! Please complete payment.'
      })
    };
  } catch (error) {
    console.error('Submit accommodation error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
