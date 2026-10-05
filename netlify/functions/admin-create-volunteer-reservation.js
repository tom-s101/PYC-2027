const { createClient } = require('@supabase/supabase-js');

// Admin tool: create accommodation reservations for volunteers (or any admin-added
// person) without requiring a registration record-link or payment proof.
//
// PYC is REQUIRED for every row. The PYC must match an existing registration
// (the frontend looks it up via lookup-by-pyc.js to auto-fill name/email/gender).
//
// Input (POST JSON):
//   {
//     volunteers: [
//       { name, email, gender, accommodationType, spots, pycNumber },
//       ...
//     ]
//   }
//
// On success:
// - Each volunteer gets an accommodation_reservations row with:
//     payment_status = 'Paid', admin_added = true, confirmation_number = entered PYC
// - Volunteers in the same batch with matching gender + same accommodation type
//   are auto-grouped into roommate requests (max 4 per group; auto-split into
//   multiple groups if more than 4).
// - Camping reservations are NOT included in roommate requests.
//
// Returns: { success, reservations: [...], roommateGroups: [...] }

const VALID_TYPES = ['girls_dorm', 'boys_dorm', 'camping'];
const VALID_GENDERS = ['Male', 'Female'];

function isValidEmail(email) {
  return typeof email === 'string' && email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function sanitize(s, max) {
  if (typeof s !== 'string') return '';
  return s.trim().substring(0, max);
}

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const volunteers = Array.isArray(parsed.volunteers) ? parsed.volunteers : [];
    if (volunteers.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'At least one volunteer required' }) };
    }
    if (volunteers.length > 50) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Maximum 50 volunteers per batch' }) };
    }

    // Validate every row first — fail fast if any are bad
    const cleaned = [];
    for (let i = 0; i < volunteers.length; i++) {
      const v = volunteers[i] || {};
      const name = sanitize(v.name, 200);
      const email = sanitize(v.email, 254).toLowerCase();
      const gender = sanitize(v.gender, 10);
      const accommodationType = sanitize(v.accommodationType, 30);
      const spots = Math.max(1, Math.min(10, parseInt(v.spots) || 1));
      const pyc = sanitize(v.pycNumber, 20).toUpperCase();

      if (!pyc) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Row ' + (i + 1) + ': PYC number is required' }) };
      }
      if (!name || name.length < 2) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Row ' + (i + 1) + ': name required (min 2 chars)' }) };
      }
      if (!isValidEmail(email)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Row ' + (i + 1) + ': valid email required' }) };
      }
      if (VALID_GENDERS.indexOf(gender) === -1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Row ' + (i + 1) + ': gender must be Male or Female' }) };
      }
      if (VALID_TYPES.indexOf(accommodationType) === -1) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Row ' + (i + 1) + ': accommodation type must be girls_dorm, boys_dorm, or camping' }) };
      }
      // Sanity: gender must match dorm type
      if (accommodationType === 'girls_dorm' && gender !== 'Female') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Row ' + (i + 1) + ' (' + name + '): cannot put a Male in the girls\' dorm' }) };
      }
      if (accommodationType === 'boys_dorm' && gender !== 'Male') {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Row ' + (i + 1) + ' (' + name + '): cannot put a Female in the boys\' dorm' }) };
      }

      cleaned.push({ name, email, gender, accommodationType, spots, pyc });
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Verify each PYC exists in registrations (defense in depth — frontend should have caught this)
    const allPycs = cleaned.map(function(v) { return v.pyc; });
    const { data: foundRegs, error: lookupErr } = await supabase
      .from('registrations')
      .select('id, confirmation_number')
      .in('confirmation_number', allPycs);

    if (lookupErr) {
      console.error('PYC verification error:', lookupErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to verify PYC numbers: ' + lookupErr.message }) };
    }

    const pycToRegId = {};
    (foundRegs || []).forEach(function(r) { pycToRegId[(r.confirmation_number || '').toUpperCase()] = r.id; });
    const missingPycs = cleaned.filter(function(v) { return !pycToRegId[v.pyc]; }).map(function(v) { return v.pyc + ' (' + v.name + ')'; });
    if (missingPycs.length > 0) {
      return { statusCode: 400, headers, body: JSON.stringify({
        error: 'These PYC number(s) do not match any registration: ' + missingPycs.join(', ')
      }) };
    }
    // Attach registration ids
    cleaned.forEach(function(v) { v.registrationId = pycToRegId[v.pyc]; });

    // Capacity check — total spots requested vs. remaining for each type
    const typeRequested = {};
    cleaned.forEach(function(v) {
      typeRequested[v.accommodationType] = (typeRequested[v.accommodationType] || 0) + v.spots;
    });

    for (const type of Object.keys(typeRequested)) {
      const { data: avail } = await supabase
        .from('accommodation_availability')
        .select('spots_remaining, display_name')
        .eq('id', type)
        .single();
      if (!avail) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Accommodation type ' + type + ' not found' }) };
      }
      if (avail.spots_remaining < typeRequested[type]) {
        return { statusCode: 409, headers, body: JSON.stringify({
          error: 'Not enough spots in ' + (avail.display_name || type) + '. Requested ' + typeRequested[type] + ', only ' + avail.spots_remaining + ' available.'
        }) };
      }
    }

    // Insert reservations
    const insertedReservations = [];
    for (const v of cleaned) {
      // Get price for this accommodation type
      const { data: accData } = await supabase
        .from('accommodation_availability')
        .select('price_per_spot, display_name')
        .eq('id', v.accommodationType)
        .single();
      const price = accData ? (accData.price_per_spot || 0) : 0;
      const totalAmount = price * v.spots;

      const { data: ins, error: insErr } = await supabase
        .from('accommodation_reservations')
        .insert([{
          registration_id: v.registrationId || null,
          registrant_name: v.name,
          registrant_email: v.email,
          accommodation_type: v.accommodationType,
          spots_requested: v.spots,
          price_per_spot: price,
          total_amount: totalAmount,
          payment_status: 'Paid',
          admin_added: true
        }])
        .select()
        .single();

      if (insErr) {
        console.error('Insert error for ' + v.name + ':', insErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({
          error: 'Failed to create reservation for ' + v.name + ': ' + insErr.message
        }) };
      }
      insertedReservations.push(ins);
    }

    // Auto-create roommate requests:
    // - Skip camping (no roommate logic for tents)
    // - Group by gender + accommodation type
    // - Each group of 2-4 gets ONE roommate request
    // - Groups larger than 4 split into multiple requests of up to 4
    // - Solo people (group of 1) skipped
    const dormPeople = cleaned.filter(function(v) { return v.accommodationType !== 'camping'; });
    const groupKey = function(v) { return v.gender + '|' + v.accommodationType; };
    const groups = {};
    dormPeople.forEach(function(v) {
      const k = groupKey(v);
      if (!groups[k]) groups[k] = [];
      groups[k].push(v);
    });

    const createdRoommateGroups = [];
    for (const k of Object.keys(groups)) {
      const arr = groups[k];
      // Split into chunks of 4
      for (let i = 0; i < arr.length; i += 4) {
        const chunk = arr.slice(i, i + 4);
        if (chunk.length < 2) continue; // skip solo

        const requester = chunk[0];
        const members = chunk.slice(1).map(function(p) {
          return { name: p.name, pycNumber: p.pyc, registrationId: null, gender: p.gender };
        });

        const { data: req, error: reqErr } = await supabase
          .from('roommate_requests')
          .insert({
            requester_registration_id: null,
            requester_name: requester.name,
            requester_email: requester.email,
            requester_pyc: requester.pyc,
            requester_gender: requester.gender,
            requested_members: members,
            status: 'Active'
          })
          .select()
          .single();

        if (reqErr) {
          console.warn('Roommate request creation failed for chunk:', reqErr.message);
          // Non-fatal: reservations are saved. Continue.
        } else if (req) {
          createdRoommateGroups.push({
            id: req.id,
            requester: requester.name + ' (' + requester.pyc + ')',
            memberCount: chunk.length
          });
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        reservationsCreated: insertedReservations.length,
        roommateGroupsCreated: createdRoommateGroups.length,
        roommateGroups: createdRoommateGroups,
        message: insertedReservations.length + ' volunteer reservation(s) created' +
          (createdRoommateGroups.length > 0 ? ', ' + createdRoommateGroups.length + ' roommate group(s) auto-created.' : '.')
      })
    };
  } catch (err) {
    console.error('admin-create-volunteer-reservation error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
