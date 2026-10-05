const { createClient } = require('@supabase/supabase-js');

// Admin tool: manually create a new roommate request on behalf of delegates.
// Used when delegates can't do it themselves or admin needs to set one up directly.
//
// Input (POST JSON):
//   { requesterPyc: 'PYC-XXXX', memberPycs: ['PYC-YYYY', 'PYC-ZZZZ', ...] }
//   (1-3 members allowed — max 4 total including requester)
//
// Validation:
//   1. Requester PYC exists and has PAID or PENDING REVIEW conference registration
//   2. Requester has an accommodation reservation with proof uploaded
//      (Pending Review / Resubmitted / Paid)
//   3. Requester is not already in any active roommate request
//   4. Each member PYC exists
//   5. Each member has PAID or PENDING REVIEW conference registration
//   6. Each member has an accommodation reservation with proof uploaded
//   7. Members are not already in any active roommate request
//   8. Gender strict match (null gender allowed — it gets mixed in either direction)

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

    const requesterPyc = (parsed.requesterPyc || '').trim().toUpperCase();
    const memberPycsRaw = Array.isArray(parsed.memberPycs) ? parsed.memberPycs : [];
    const memberPycs = memberPycsRaw.map(function(p) { return (p || '').trim().toUpperCase(); }).filter(function(p) { return p.length > 0; });

    if (!requesterPyc) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Requester PYC number required' }) };
    }
    if (memberPycs.length < 1) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'At least one member PYC is required' }) };
    }
    if (memberPycs.length > 3) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Maximum 3 members allowed (4 total including requester)' }) };
    }

    // Check for duplicate PYCs in the submission
    const allPycs = [requesterPyc].concat(memberPycs);
    const uniquePycs = new Set(allPycs);
    if (uniquePycs.size !== allPycs.length) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Duplicate PYC numbers in request. Each person can only appear once.' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Load all registrations involved
    const { data: regs, error: regErr } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, confirmation_number, payment_status')
      .in('confirmation_number', allPycs);

    if (regErr) {
      console.error('Registration lookup error:', regErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to look up registrations' }) };
    }

    if (!regs || regs.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'None of the provided PYC numbers were found' }) };
    }

    // Index by PYC for easy lookup
    const regByPyc = {};
    regs.forEach(function(r) {
      if (r.confirmation_number) regByPyc[r.confirmation_number.toUpperCase()] = r;
    });

    // Verify every PYC was found
    const missing = allPycs.filter(function(p) { return !regByPyc[p]; });
    if (missing.length > 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'PYC number(s) not found: ' + missing.join(', ') }) };
    }

    const requester = regByPyc[requesterPyc];

    // 1. Requester must have a confirmed conference registration (Paid or Pending Review)
    const VALID_REG_STATUSES = ['Paid', 'Pending Review'];
    if (!VALID_REG_STATUSES.includes(requester.payment_status)) {
      return { statusCode: 400, headers, body: JSON.stringify({
        error: requester.first_name + ' ' + requester.last_name + ' (requester) has not submitted payment for their conference registration yet. Current status: ' + (requester.payment_status || 'Pending')
      }) };
    }

    // 2. Each member must also have a confirmed conference registration (Paid or Pending Review)
    for (const pyc of memberPycs) {
      const m = regByPyc[pyc];
      if (!VALID_REG_STATUSES.includes(m.payment_status)) {
        return { statusCode: 400, headers, body: JSON.stringify({
          error: m.first_name + ' ' + m.last_name + ' (' + pyc + ') has not submitted payment for their conference registration yet. Current status: ' + (m.payment_status || 'Pending')
        }) };
      }
    }

    // 3. Every person must have an accommodation reservation with proof uploaded.
    // Check by registration_id AND by email (since group members often share primary's email)
    const regIds = allPycs.map(function(p) { return regByPyc[p].id; });
    const emails = allPycs.map(function(p) { return (regByPyc[p].email || '').toLowerCase(); }).filter(Boolean);

    const { data: reservationsByRegId } = await supabase
      .from('accommodation_reservations')
      .select('registration_id, registrant_email, payment_status')
      .in('registration_id', regIds)
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);

    const { data: reservationsByEmail } = await supabase
      .from('accommodation_reservations')
      .select('registration_id, registrant_email, payment_status')
      .in('registrant_email', emails)
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);

    const hasReservation = function(pyc) {
      const reg = regByPyc[pyc];
      if (!reg) return false;
      // Check by registration_id
      if ((reservationsByRegId || []).some(function(r) { return r.registration_id === reg.id; })) return true;
      // Check by email
      const email = (reg.email || '').toLowerCase();
      if (email && (reservationsByEmail || []).some(function(r) { return (r.registrant_email || '').toLowerCase() === email; })) return true;
      return false;
    };

    if (!hasReservation(requesterPyc)) {
      return { statusCode: 400, headers, body: JSON.stringify({
        error: requester.first_name + ' ' + requester.last_name + ' (requester) does not have an active accommodation reservation with proof uploaded. They must reserve accommodation first.'
      }) };
    }

    for (const pyc of memberPycs) {
      if (!hasReservation(pyc)) {
        const m = regByPyc[pyc];
        return { statusCode: 400, headers, body: JSON.stringify({
          error: m.first_name + ' ' + m.last_name + ' (' + pyc + ') does not have an active accommodation reservation with proof uploaded. They must reserve accommodation first.'
        }) };
      }
    }

    // 4. Gender check — strict match unless one side is null (unknown)
    const requesterGender = requester.gender || null;
    for (const pyc of memberPycs) {
      const m = regByPyc[pyc];
      const mGender = m.gender || null;
      // Both specified and different = block. Either null = allow.
      if (requesterGender && mGender && requesterGender !== mGender) {
        return { statusCode: 400, headers, body: JSON.stringify({
          error: m.first_name + ' ' + m.last_name + ' is ' + mGender + ' but ' + requester.first_name + ' ' + requester.last_name + ' is ' + requesterGender + '. Dorms are gender-separated, so they cannot be in the same roommate group.'
        }) };
      }
    }

    // 5. Pre-fetch: find which registration_ids have valid (proof-uploaded) reservations.
    // This is used to filter out STALE roommate requests from requesters who abandoned/lost their reservation.
    const { data: validReservations } = await supabase
      .from('accommodation_reservations')
      .select('registration_id')
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);
    const validRegIds = new Set((validReservations || []).map(function(r) { return r.registration_id; }).filter(Boolean));

    // 6. Check that no one in the group (requester or members) is already in an active roommate request.
    // Load all active requests, then filter to only ones backed by valid reservations.
    const { data: allRequestsRaw } = await supabase
      .from('roommate_requests')
      .select('id, requester_name, requester_pyc, requester_registration_id, requested_members')
      .eq('status', 'Active');

    const activeRequests = (allRequestsRaw || []).filter(function(r) {
      return validRegIds.has(r.requester_registration_id);
    });

    // Check requester isn't already in any active group
    for (const req of activeRequests) {
      if ((req.requester_pyc || '').toUpperCase() === requesterPyc) {
        return { statusCode: 400, headers, body: JSON.stringify({
          error: requester.first_name + ' ' + requester.last_name + ' already has their own active roommate request. They need to cancel it first before creating a new one.'
        }) };
      }
      const mbrs = Array.isArray(req.requested_members) ? req.requested_members : [];
      for (const m of mbrs) {
        if (m.pycNumber && m.pycNumber.toUpperCase() === requesterPyc) {
          return { statusCode: 400, headers, body: JSON.stringify({
            error: requester.first_name + ' ' + requester.last_name + ' is already in ' + req.requester_name + '\'s roommate group. They cannot be the requester of a new group.'
          }) };
        }
      }
    }

    // Check each member isn't already in any active group
    for (const pyc of memberPycs) {
      const m = regByPyc[pyc];
      for (const req of activeRequests) {
        if ((req.requester_pyc || '').toUpperCase() === pyc) {
          return { statusCode: 400, headers, body: JSON.stringify({
            error: m.first_name + ' ' + m.last_name + ' already has their own active roommate request. Cancel theirs first before adding them to another group.'
          }) };
        }
        const mbrs = Array.isArray(req.requested_members) ? req.requested_members : [];
        for (const existing of mbrs) {
          if (existing.pycNumber && existing.pycNumber.toUpperCase() === pyc) {
            return { statusCode: 400, headers, body: JSON.stringify({
              error: m.first_name + ' ' + m.last_name + ' is already in ' + req.requester_name + '\'s roommate group. They can only be in one group.'
            }) };
          }
        }
      }
    }

    // All validations passed — build the member array and insert
    const requestedMembers = memberPycs.map(function(pyc) {
      const m = regByPyc[pyc];
      return {
        name: m.first_name + ' ' + m.last_name,
        pycNumber: m.confirmation_number,
        registrationId: m.id,
        gender: m.gender || null
      };
    });

    const { data: inserted, error: insertErr } = await supabase
      .from('roommate_requests')
      .insert({
        requester_registration_id: requester.id,
        requester_name: requester.first_name + ' ' + requester.last_name,
        requester_email: requester.email,
        requester_pyc: requester.confirmation_number,
        requester_gender: requester.gender || null,
        requested_members: requestedMembers,
        status: 'Active'
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Insert error:', insertErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to create roommate request: ' + insertErr.message }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Roommate request created successfully for ' + requester.first_name + ' ' + requester.last_name + ' with ' + requestedMembers.length + ' member(s).',
        requestId: inserted.id,
        requesterName: requester.first_name + ' ' + requester.last_name,
        memberCount: requestedMembers.length
      })
    };
  } catch (err) {
    console.error('admin-create-roommate-request error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
