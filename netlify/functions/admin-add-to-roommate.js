const { createClient } = require('@supabase/supabase-js');

// Admin tool: manually add a registered delegate to an existing roommate request.
// Used when someone should be grouped together but wasn't included in the original request.
//
// Input (POST JSON):
//   { requestId: UUID, pycNumber: string, searchName?: string }
//
// Validation performed:
//   1. requestId exists and is Active
//   2. PYC exists and the name matches (fuzzy)
//   3. Person has uploaded payment proof for accommodation (Pending Review / Resubmitted / Paid)
//   4. Person is not already in this or any other active roommate request
//   5. Group doesn't exceed max 4 members (1 requester + 3 requested = 4)

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

    const requestId = (parsed.requestId || '').trim();
    const pycNumber = (parsed.pycNumber || '').trim().toUpperCase();
    const searchName = (parsed.searchName || '').trim().toLowerCase();
    const forceOverride = parsed.forceOverride === true;

    if (!requestId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'requestId required' }) };
    if (!pycNumber) return { statusCode: 400, headers, body: JSON.stringify({ error: 'PYC number required' }) };

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // 1. Load the target roommate request
    const { data: targetReq, error: reqErr } = await supabase
      .from('roommate_requests')
      .select('*')
      .eq('id', requestId)
      .eq('status', 'Active')
      .single();

    if (reqErr || !targetReq) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Roommate request not found or not active' }) };
    }

    const currentMembers = Array.isArray(targetReq.requested_members) ? targetReq.requested_members : [];
    // Max 4 total (1 requester + 3 requested)
    if (currentMembers.length >= 3) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'This roommate group already has the maximum 4 members. Cannot add more.' }) };
    }

    // 2. Look up the person by PYC
    const { data: matches } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender, confirmation_number')
      .eq('confirmation_number', pycNumber);

    if (!matches || matches.length === 0) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'No registrant found with PYC ' + pycNumber }) };
    }

    let person = matches[0];

    // Optional name check (fuzzy) when multiple match or for confirmation
    if (searchName && matches.length > 1) {
      const named = matches.find(function(m) {
        var full = (m.first_name + ' ' + m.last_name).toLowerCase();
        return full.includes(searchName) || searchName.includes((m.first_name || '').toLowerCase());
      });
      if (named) person = named;
    }

    // 3. Check that person has a reservation with proof uploaded
    const { data: res } = await supabase
      .from('accommodation_reservations')
      .select('id, payment_status')
      .eq('registration_id', person.id)
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);

    const hasReservation = res && res.length > 0;
    if (!hasReservation) {
      // Also check by email (in case the reservation was made under the primary's registration_id,
      // which is common for group members)
      const { data: emailRes } = await supabase
        .from('accommodation_reservations')
        .select('id, payment_status')
        .ilike('registrant_email', person.email || '')
        .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);
      if (!emailRes || emailRes.length === 0) {
        return { statusCode: 400, headers, body: JSON.stringify({
          error: person.first_name + ' ' + person.last_name + ' does not have an active accommodation reservation. They must reserve first.'
        }) };
      }
    }

    // 4. Check person isn't already in any roommate group (including this one)
    // Preflight: gather valid reservation owners (so stale rejected requests don't block)
    const { data: validReservations } = await supabase
      .from('accommodation_reservations')
      .select('registration_id')
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);
    const validRegIds = new Set((validReservations || []).map(function(r) { return r.registration_id; }).filter(Boolean));

    // Check if they made their own request
    const { data: ownReqs } = await supabase
      .from('roommate_requests')
      .select('id, requester_name, requester_registration_id')
      .eq('requester_pyc', pycNumber)
      .eq('status', 'Active');
    const blockingOwn = (ownReqs || []).filter(function(r) { return validRegIds.has(r.requester_registration_id); });
    if (blockingOwn.length > 0) {
      return { statusCode: 400, headers, body: JSON.stringify({
        error: person.first_name + ' ' + person.last_name + ' already has their own roommate request. Cancel theirs first.'
      }) };
    }

    // Check if they're in someone else's request
    const { data: allReqs } = await supabase
      .from('roommate_requests')
      .select('id, requester_name, requester_registration_id, requested_members')
      .eq('status', 'Active');

    for (const req of (allReqs || [])) {
      if (!validRegIds.has(req.requester_registration_id)) continue; // stale, ignore
      const mbrs = Array.isArray(req.requested_members) ? req.requested_members : [];
      for (const m of mbrs) {
        if (m.pycNumber && m.pycNumber.toUpperCase() === pycNumber) {
          if (req.id === requestId) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: person.first_name + ' is already in this group.' }) };
          }
          return { statusCode: 400, headers, body: JSON.stringify({
            error: person.first_name + ' ' + person.last_name + ' is already in ' + req.requester_name + '\'s roommate group.'
          }) };
        }
      }
    }

    // 5. Gender check — warn (not block) if genders don't match.
    // Dorms are gender-restricted, so mismatched groups will fail auto-assign.
    // Admin can override by re-submitting with forceOverride=true.
    const personGender = person.gender || null;
    const requestGender = targetReq.requester_gender || null;
    if (!forceOverride && personGender && requestGender && personGender !== requestGender) {
      return {
        statusCode: 409,
        headers,
        body: JSON.stringify({
          genderMismatch: true,
          personName: person.first_name + ' ' + person.last_name,
          personGender: personGender,
          requestGender: requestGender,
          requesterName: targetReq.requester_name,
          message: person.first_name + ' is ' + personGender + ' but this group is ' + requestGender + '. Dorms are gender-separated, so this may cause auto-assign to fail.'
        })
      };
    }

    // 6. All checks passed — append to the request
    const newMember = {
      name: person.first_name + ' ' + person.last_name,
      pycNumber: person.confirmation_number,
      registrationId: person.id,
      gender: person.gender || null
    };
    const updatedMembers = currentMembers.concat([newMember]);

    const { error: updateErr } = await supabase
      .from('roommate_requests')
      .update({ requested_members: updatedMembers })
      .eq('id', requestId);

    if (updateErr) {
      console.error('Update error:', updateErr.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update roommate request' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: newMember.name + ' added to ' + targetReq.requester_name + '\'s roommate group',
        addedMember: newMember
      })
    };
  } catch (err) {
    console.error('admin-add-to-roommate error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
