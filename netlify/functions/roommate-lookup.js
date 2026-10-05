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
    const pycNumber = (parsed.pycNumber || '').trim().toUpperCase();
    const companionName = (parsed.companionName || '').trim();

    if (!pycNumber) return { statusCode: 400, headers, body: JSON.stringify({ error: 'PYC number required.' }) };
    if (!companionName) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Name required.' }) };

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Look up registration by confirmation number
    const { data: reg, error: regErr } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, confirmation_number, gender, payment_status')
      .eq('confirmation_number', pycNumber)
      .single();

    if (regErr || !reg) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false, message: 'No match found. Check the name and PYC number.' }) };
    }

    // Verify name matches (case-insensitive, flexible matching)
    const dbFullName = `${reg.first_name} ${reg.last_name}`.toLowerCase().trim();
    const inputName = companionName.toLowerCase().trim();
    const dbFirst = reg.first_name.toLowerCase().trim();
    const dbLast = reg.last_name.toLowerCase().trim();

    const nameMatch = (inputName === dbFullName) ||
                      (inputName === dbFirst + ' ' + dbLast) ||
                      (inputName === dbLast + ', ' + dbFirst) ||
                      (inputName === dbFirst && dbFirst.length >= 2) ||
                      (inputName === dbLast && dbLast.length >= 2) ||
                      (dbFullName.includes(inputName) && inputName.length >= 3);

    if (!nameMatch) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false, message: 'No match found. Check the name and PYC number.' }) };
    }

    // Check if this person has already been requested or has their own request.
    // Only consider requests where the requester has uploaded proof
    // (Pending Review / Resubmitted / Paid). Requesters who are still 'Pending'
    // (no proof uploaded) or 'Rejected' should NOT block others from requesting
    // the same members, since they haven't actually completed their reservation.
    const { data: validReservations } = await supabase
      .from('accommodation_reservations')
      .select('registration_id')
      .in('payment_status', ['Pending Review', 'Resubmitted', 'Paid']);
    const validRegIds = new Set((validReservations || []).map(r => r.registration_id).filter(Boolean));

    const { data: allRequestsRaw } = await supabase
      .from('roommate_requests')
      .select('requester_name, requester_pyc, requester_registration_id, requested_members')
      .eq('status', 'Active');

    // Filter to only requests from requesters with valid reservations
    const allRequests = (allRequestsRaw || []).filter(r => validRegIds.has(r.requester_registration_id));

    let alreadyInGroup = false;
    let groupOwner = '';

    for (const req of allRequests) {
      // Check if they are the requester
      if (req.requester_pyc === pycNumber) {
        alreadyInGroup = true;
        groupOwner = 'themselves (they made their own request)';
        break;
      }
      // Check if they are in someone's requested members
      const members = Array.isArray(req.requested_members) ? req.requested_members : [];
      for (const m of members) {
        if (m.pycNumber && m.pycNumber.toUpperCase() === pycNumber) {
          alreadyInGroup = true;
          groupOwner = req.requester_name;
          break;
        }
      }
      if (alreadyInGroup) break;
    }

    // Check if they have a dorm reservation
    const { data: accommRes } = await supabase
      .from('accommodation_reservations')
      .select('id')
      .eq('registration_id', reg.id)
      .in('payment_status', ['Pending', 'Pending Review', 'Resubmitted', 'Paid']);

    const hasDorm = accommRes && accommRes.length > 0;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: true,
        name: `${reg.first_name} ${reg.last_name}`,
        pycNumber: reg.confirmation_number,
        registrationId: reg.id,
        gender: reg.gender,
        paymentStatus: reg.payment_status,
        alreadyInGroup,
        groupOwner,
        hasDormReservation: hasDorm
      })
    };
  } catch (err) {
    console.error('Roommate lookup error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error.' }) };
  }
};
