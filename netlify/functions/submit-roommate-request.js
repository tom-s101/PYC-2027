const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const parsed = JSON.parse(event.body);
    const { registrationId, requesterName, requesterEmail, requesterPyc, requesterGender, requestedMembers } = parsed;

    // Validate required fields (requesterGender is optional — some delegates didn't
    // specify their gender during registration; frontend note warns admins/users about
    // gender-separated dorms in that case)
    if (!registrationId || !requesterName || !requesterEmail || !requesterPyc) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Missing required fields.' }) };
    }

    if (!Array.isArray(requestedMembers) || requestedMembers.length === 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Please add at least one roommate.' }) };
    }

    if (requestedMembers.length > 3) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'You can request a maximum of 3 roommates.' }) };
    }

    // Validate all requested members. Gender is optional — some delegates registered
    // without specifying one. When BOTH sides have a gender specified, they must match.
    // When either side is null/blank, we allow the add (admin note on frontend warns
    // users to be careful since dorms are gender-separated).
    for (const m of requestedMembers) {
      if (!m.name || !m.pycNumber || !m.registrationId) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid member data.' }) };
      }
      if (m.gender && requesterGender && m.gender !== requesterGender) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Roommate requests must be same gender. ${m.name} is ${m.gender} but you are ${requesterGender}.` }) };
      }
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Pre-fetch all registration_ids that currently have CONFIRMED accommodation reservations
    // (Pending Review, Resubmitted, or Paid — meaning payment proof has been uploaded).
    // We exclude 'Pending' because that means the reservation was created but proof was
    // never uploaded — likely abandoned. We also exclude Rejected/Cancelled.
    // This prevents abandoned or rejected reservations from permanently blocking other
    // users from requesting the same members.
    const { data: validReservations } = await supabase
      .from('accommodation_reservations')
      .select('registration_id')
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);

    const validRegIds = new Set((validReservations || []).map(r => r.registration_id).filter(Boolean));

    // Check if requester already has an active request (self-check — keep as-is,
    // so user can't spam requests even if their reservation lapsed)
    const { data: existing } = await supabase
      .from('roommate_requests')
      .select('id')
      .eq('requester_registration_id', registrationId)
      .eq('status', 'Active');

    if (existing && existing.length > 0) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'You already have an active roommate request. Cancel it first to make a new one.' }) };
    }

    // Check if requester has been requested by someone else
    // Only consider requests whose requester has a valid reservation.
    const { data: allRequestsRaw } = await supabase
      .from('roommate_requests')
      .select('requester_name, requester_registration_id, requested_members')
      .eq('status', 'Active');

    // Filter to only requests from requesters with valid reservations
    const allRequests = (allRequestsRaw || []).filter(r => validRegIds.has(r.requester_registration_id));

    for (const req of allRequests) {
      const members = Array.isArray(req.requested_members) ? req.requested_members : [];
      for (const m of members) {
        if (m.pycNumber && m.pycNumber.toUpperCase() === requesterPyc.toUpperCase()) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: `${req.requester_name} has already requested you as a roommate. You cannot make a separate request.` }) };
        }
      }
    }

    // Check that none of the requested members have already made their own request
    // (only block if their request is backed by a valid reservation)
    for (const m of requestedMembers) {
      const { data: memberReq } = await supabase
        .from('roommate_requests')
        .select('id, requester_name, requester_registration_id')
        .eq('requester_pyc', m.pycNumber.toUpperCase())
        .eq('status', 'Active');

      const activeMemberReq = (memberReq || []).filter(r => validRegIds.has(r.requester_registration_id));
      if (activeMemberReq.length > 0) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `${m.name} has already made their own roommate request. They need to cancel theirs first, or you can ask them to include you in their request.` }) };
      }
    }

    // Check that none of the requested members have been requested by someone else
    // (already using filtered allRequests — so stale requests are ignored)
    for (const m of requestedMembers) {
      for (const req of allRequests) {
        const members = Array.isArray(req.requested_members) ? req.requested_members : [];
        for (const rm of members) {
          if (rm.pycNumber && rm.pycNumber.toUpperCase() === m.pycNumber.toUpperCase()) {
            return { statusCode: 400, headers, body: JSON.stringify({ error: `${m.name} has already been requested by ${req.requester_name}. They can only be in one roommate group.` }) };
          }
        }
      }
    }

    // All validations passed — insert the request
    const { data: inserted, error: insertErr } = await supabase
      .from('roommate_requests')
      .insert({
        requester_registration_id: registrationId,
        requester_name: requesterName,
        requester_email: requesterEmail,
        requester_pyc: requesterPyc.toUpperCase(),
        requester_gender: requesterGender,
        requested_members: requestedMembers,
        status: 'Active'
      })
      .select()
      .single();

    if (insertErr) {
      console.error('Insert error:', insertErr);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to save roommate request.' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Roommate request submitted successfully!',
        requestId: inserted.id
      })
    };
  } catch (err) {
    console.error('Submit roommate request error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error.' }) };
  }
};
