const { createClient } = require('@supabase/supabase-js');

// Rate limiting - prevents email enumeration attacks
const lookupAttempts = new Map();
const MAX_LOOKUPS = 10; // per IP per window
const WINDOW_MS = 5 * 60 * 1000; // 5 minutes

function isRateLimited(ip) {
  const now = Date.now();
  const data = lookupAttempts.get(ip);
  if (!data || now - data.windowStart > WINDOW_MS) {
    lookupAttempts.set(ip, { count: 1, windowStart: now });
    return false;
  }
  data.count++;
  if (data.count > MAX_LOOKUPS) return true;
  return false;
}

// Simple email format check
function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
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
    // Rate limit check
    const clientIP = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    if (isRateLimited(clientIP)) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many requests. Please wait a few minutes.' }) };
    }

    // Payload size check (reject huge payloads)
    if (event.body && event.body.length > 1024) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request too large' }) };
    }

    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const email = (parsed.email || '').trim().toLowerCase();
    const nameFilter = (parsed.name || '').trim().toLowerCase();
    const pycNumber = (parsed.pycNumber || '').trim().toUpperCase();
    if (!email || !isValidEmail(email)) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid email required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Use case-insensitive email matching (.ilike) because emails in the DB may be
    // stored with different casing than what the user types (e.g. John@Gmail.com vs
    // john@gmail.com). We pass the email as-is (no wildcards) so ilike acts as a
    // case-insensitive equality check.
    const { data: registrations, error } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, age, registration_type, group_id, is_primary, payment_status, confirmation_number, region')
      .ilike('email', email)
      .order('created_at', { ascending: false })
      .limit(20);

    if (error) {
      console.error('Lookup error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }

    if (!registrations || registrations.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false, message: 'No registration found for this email.' }) };
    }

    // If PYC provided, narrow to the specific registration. This prevents picking
    // the wrong record when the same email has multiple registrations (e.g. a primary
    // of one group AND an individual registration, or a user who re-registered after
    // a failed attempt). We need to find the group/record that contains this PYC.
    let filtered = registrations;
    if (pycNumber) {
      // First: find the exact record with this PYC
      const directMatch = registrations.find(r =>
        r.confirmation_number && r.confirmation_number.toUpperCase() === pycNumber
      );

      if (directMatch) {
        if (directMatch.group_id) {
          // PYC belongs to a group member — fetch all members of that group
          const { data: groupRecs } = await supabase
            .from('registrations')
            .select('id, first_name, last_name, email, gender, age, registration_type, group_id, is_primary, payment_status, confirmation_number, region')
            .eq('group_id', directMatch.group_id)
            .order('is_primary', { ascending: false });
          if (groupRecs && groupRecs.length > 0) filtered = groupRecs;
          else filtered = [directMatch];
        } else {
          filtered = [directMatch];
        }
      } else {
        // PYC not directly found under this email — fall back to name filter below
      }
    }

    // If name provided (and we didn't narrow by PYC), try to match by name
    if (filtered === registrations && nameFilter && registrations.length > 1) {
      const nameMatched = registrations.filter(r => 
        `${r.first_name} ${r.last_name}`.toLowerCase().includes(nameFilter) ||
        nameFilter.includes(r.first_name.toLowerCase())
      );
      if (nameMatched.length > 0) filtered = nameMatched;
    }

    const primary = filtered.find(r => r.is_primary === true || r.registration_type === 'individual') || filtered[0];
    const isGroup = primary.registration_type === 'group' && primary.group_id;

    let groupMembers = [];
    if (isGroup) {
      const { data: members } = await supabase
        .from('registrations')
        .select('id, first_name, last_name, gender, age, is_primary, confirmation_number')
        .eq('group_id', primary.group_id)
        .order('is_primary', { ascending: false })
        .limit(30);
      groupMembers = members || [];
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: true,
        registrationId: primary.id,
        name: `${primary.first_name} ${primary.last_name}`,
        email: primary.email,
        paymentStatus: primary.payment_status || 'Pending',
        isGroup: !!isGroup,
        groupId: primary.group_id || null,
        region: primary.region || null,
        memberCount: isGroup ? groupMembers.length : 1,
        members: isGroup ? groupMembers.map(m => ({
          id: m.id,
          name: `${m.first_name} ${m.last_name}`,
          gender: m.gender,
          age: m.age,
          isPrimary: m.is_primary,
          confirmationNumber: m.confirmation_number || null
        })) : [{
          id: primary.id,
          name: `${primary.first_name} ${primary.last_name}`,
          gender: primary.gender,
          age: primary.age,
          isPrimary: true,
          confirmationNumber: primary.confirmation_number || null
        }]
      })
    };
  } catch (error) {
    console.error('Lookup registration error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
