const { createClient } = require('@supabase/supabase-js');

// Admin tool: cancel an accommodation reservation with full cleanup.
// What it does:
//   1. Marks the reservation as 'Cancelled'
//   2. Removes the person from any room assignment (cleanup)
//   3. Removes them from any active roommate request they're in or own
//   4. Returns a summary of what was changed
//
// Note: This does NOT email the registrant — admin handles communication
// outside the system. (If you want optional email later, add a sendEmail flag
// and wire it to accommodation-email-helper.js's sendRejectedEmail.)
//
// Input (POST JSON): { reservationId, reason?: string }
// Output: { success, message, cleanup: { roomsModified, roommateRequestsModified } }

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

    const reservationId = parsed.reservationId;
    const reason = (parsed.reason || 'Cancelled by admin').toString().substring(0, 500);

    if (!reservationId) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'reservationId required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Fetch the reservation
    const { data: res, error: resErr } = await supabase
      .from('accommodation_reservations')
      .select('*')
      .eq('id', reservationId)
      .single();

    if (resErr || !res) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Reservation not found' }) };
    }

    if (res.payment_status === 'Cancelled') {
      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        message: 'Reservation was already cancelled. No changes made.',
        alreadyCancelled: true
      }) };
    }

    // Resolve the registrant's PYC for cleanup work. The reservation has
    // registrant_email and registration_id; the PYC lives on the linked
    // registration.
    let pyc = '';
    if (res.registration_id) {
      const { data: reg } = await supabase
        .from('registrations')
        .select('confirmation_number')
        .eq('id', res.registration_id)
        .single();
      if (reg) pyc = (reg.confirmation_number || '').toUpperCase();
    }

    // === Cancel the reservation ===
    const { error: cancelErr } = await supabase
      .from('accommodation_reservations')
      .update({
        payment_status: 'Cancelled',
        rejection_reason: reason
      })
      .eq('id', reservationId);

    if (cancelErr) {
      // Try without the rejection_reason column in case it doesn't exist
      const { error: cancelErr2 } = await supabase
        .from('accommodation_reservations')
        .update({ payment_status: 'Cancelled' })
        .eq('id', reservationId);
      if (cancelErr2) {
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to cancel reservation: ' + cancelErr2.message }) };
      }
    }

    let roomsModified = 0;
    let roommateRequestsModified = 0;

    // === Cleanup room assignments ===
    if (pyc) {
      const { data: rooms } = await supabase
        .from('room_assignments')
        .select('*');
      for (const room of (rooms || [])) {
        const members = room.members || [];
        const hasMember = members.some(function(m) { return (m.pycNumber || '').toUpperCase() === pyc; });
        if (!hasMember) continue;

        const filtered = members.filter(function(m) { return (m.pycNumber || '').toUpperCase() !== pyc; });
        if (filtered.length === 0) {
          // Room becomes empty — delete it
          const { error: delErr } = await supabase
            .from('room_assignments')
            .delete()
            .eq('id', room.id);
          if (!delErr) roomsModified++;
        } else {
          const { error: updErr } = await supabase
            .from('room_assignments')
            .update({ members: filtered })
            .eq('id', room.id);
          if (!updErr) roomsModified++;
        }
      }
    }

    // === Cleanup roommate requests ===
    if (pyc) {
      // 1. They might be the requester of an active request
      const { data: ownedRequests } = await supabase
        .from('roommate_requests')
        .select('*')
        .eq('requester_pyc', pyc)
        .eq('status', 'Active');

      for (const req of (ownedRequests || [])) {
        const members = req.requested_members || [];
        // Find the first member who actually has a PYC — promoting a memberless
        // person would create a null-PYC requester and corrupt the auto-assign data.
        const promotable = members.find(function(m) { return m && m.pycNumber; });
        if (promotable) {
          const newMembers = members.filter(function(m) { return m !== promotable; });
          // Look up the new requester's full registration info if available
          let newGender = req.requester_gender;
          let newEmail = req.requester_email;
          const { data: newReg } = await supabase
            .from('registrations')
            .select('email, gender')
            .eq('confirmation_number', promotable.pycNumber)
            .single();
          if (newReg) {
            newEmail = newReg.email || newEmail;
            newGender = newReg.gender || newGender;
          }
          const { error: updErr } = await supabase
            .from('roommate_requests')
            .update({
              requester_name: promotable.name || '',
              requester_pyc: promotable.pycNumber,
              requester_email: newEmail,
              requester_gender: newGender,
              requested_members: newMembers
            })
            .eq('id', req.id);
          if (!updErr) roommateRequestsModified++;
        } else {
          // No promotable member — cancel the request entirely
          const { error: updErr } = await supabase
            .from('roommate_requests')
            .update({ status: 'Cancelled' })
            .eq('id', req.id);
          if (!updErr) roommateRequestsModified++;
        }
      }

      // 2. They might be a MEMBER of someone else's active request
      const { data: allActiveRequests } = await supabase
        .from('roommate_requests')
        .select('*')
        .eq('status', 'Active');
      for (const req of (allActiveRequests || [])) {
        if (req.requester_pyc && req.requester_pyc.toUpperCase() === pyc) continue; // already handled above
        const members = req.requested_members || [];
        const hasMember = members.some(function(m) { return (m.pycNumber || '').toUpperCase() === pyc; });
        if (!hasMember) continue;
        const filtered = members.filter(function(m) { return (m.pycNumber || '').toUpperCase() !== pyc; });
        const { error: updErr } = await supabase
          .from('roommate_requests')
          .update({ requested_members: filtered })
          .eq('id', req.id);
        if (!updErr) roommateRequestsModified++;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: 'Reservation cancelled for ' + (res.registrant_name || '?') +
          (roomsModified > 0 ? '. Removed from ' + roomsModified + ' room assignment' + (roomsModified === 1 ? '' : 's') : '') +
          (roommateRequestsModified > 0 ? '. Updated ' + roommateRequestsModified + ' roommate request' + (roommateRequestsModified === 1 ? '' : 's') : '') +
          '.',
        cleanup: {
          roomsModified: roomsModified,
          roommateRequestsModified: roommateRequestsModified
        }
      })
    };
  } catch (err) {
    console.error('cancel-reservation error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
