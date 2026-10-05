const { createClient } = require('@supabase/supabase-js');

// Admin tool: mark an accommodation (dorm) reservation as 'Volunteer'.
// Used when a person will stay in separate volunteer accommodation, freeing
// their dorm spot for others.
//
// What it does:
//   1. Sets the reservation's payment_status to 'Volunteer'
//   2. FREES the spot(s) back into accommodation_availability (capacity goes up)
//   3. Removes the person from any current room assignment
//   4. Removes them from any active roommate request (as member or requester)
//   5. They will be excluded from future auto-assign runs (Volunteer is not an
//      assignable status)
//
// Payment record is left intact (amount paid, proof, etc.) — only the status
// changes. No email is sent (admin handles volunteer communication separately).
//
// Input (POST JSON): { reservationId }
// Output: { success, message, freedSpots, cleanup: {...} }
//
// Re-runnable: if already 'Volunteer', it makes no further changes (won't double-free spots).

const FREED_FROM_STATUSES = ['Pending', 'Paid', 'Pending Review', 'Resubmitted'];

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

    // Only dorm reservations are relevant here (tents are a different model)
    if (res.accommodation_type !== 'girls_dorm' && res.accommodation_type !== 'boys_dorm') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'This is not a dorm reservation (' + (res.accommodation_type || 'unknown') + '). Only dorm reservations can be marked Volunteer here.' }) };
    }

    if (res.payment_status === 'Volunteer') {
      return { statusCode: 200, headers, body: JSON.stringify({
        success: true,
        message: 'This reservation is already marked Volunteer. No changes made.',
        alreadyVolunteer: true
      }) };
    }

    // Whether we should free the spots: only if the reservation currently holds a
    // live spot (i.e., it was in an active status that had decremented availability).
    const shouldFreeSpots = FREED_FROM_STATUSES.includes(res.payment_status);
    const spotsToFree = parseInt(res.spots_requested, 10) || 0;

    // Resolve the registrant's PYC for cleanup work
    let pyc = '';
    if (res.registration_id) {
      const { data: reg } = await supabase
        .from('registrations')
        .select('confirmation_number')
        .eq('id', res.registration_id)
        .single();
      if (reg) pyc = (reg.confirmation_number || '').toUpperCase();
    }

    // === 1. Set status to Volunteer ===
    const { error: updErr } = await supabase
      .from('accommodation_reservations')
      .update({ payment_status: 'Volunteer' })
      .eq('id', reservationId);
    if (updErr) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to update reservation: ' + updErr.message }) };
    }

    // === 2. Free the spots back into availability ===
    let freedSpots = 0;
    if (shouldFreeSpots && spotsToFree > 0) {
      const { data: avail } = await supabase
        .from('accommodation_availability')
        .select('spots_remaining, total_spots')
        .eq('id', res.accommodation_type)
        .single();
      if (avail) {
        let newRemaining = (avail.spots_remaining || 0) + spotsToFree;
        // Never exceed total_spots (defensive clamp)
        if (avail.total_spots != null && newRemaining > avail.total_spots) {
          newRemaining = avail.total_spots;
        }
        const { error: freeErr } = await supabase
          .from('accommodation_availability')
          .update({ spots_remaining: newRemaining })
          .eq('id', res.accommodation_type);
        if (!freeErr) freedSpots = spotsToFree;
      }
    }

    // === 3. Remove from room assignments ===
    let roomsModified = 0;
    if (pyc) {
      const { data: rooms } = await supabase.from('room_assignments').select('*');
      for (const room of (rooms || [])) {
        const members = room.members || [];
        const hasMember = members.some(function(m) { return (m.pycNumber || '').toUpperCase() === pyc; });
        if (!hasMember) continue;
        const filtered = members.filter(function(m) { return (m.pycNumber || '').toUpperCase() !== pyc; });
        if (filtered.length === 0) {
          const { error: delErr } = await supabase.from('room_assignments').delete().eq('id', room.id);
          if (!delErr) roomsModified++;
        } else {
          const { error: rUpdErr } = await supabase.from('room_assignments').update({ members: filtered }).eq('id', room.id);
          if (!rUpdErr) roomsModified++;
        }
      }
    }

    // === 4. Cleanup roommate requests ===
    let roommateRequestsModified = 0;
    if (pyc) {
      // Owned requests — promote a member or cancel
      const { data: ownedRequests } = await supabase
        .from('roommate_requests').select('*')
        .eq('requester_pyc', pyc).eq('status', 'Active');
      for (const req of (ownedRequests || [])) {
        const members = req.requested_members || [];
        const promotable = members.find(function(m) { return m && m.pycNumber; });
        if (promotable) {
          const newMembers = members.filter(function(m) { return m !== promotable; });
          let newGender = req.requester_gender, newEmail = req.requester_email;
          const { data: newReg } = await supabase
            .from('registrations').select('email, gender')
            .eq('confirmation_number', promotable.pycNumber).single();
          if (newReg) { newEmail = newReg.email || newEmail; newGender = newReg.gender || newGender; }
          const { error: pErr } = await supabase.from('roommate_requests').update({
            requester_name: promotable.name || '', requester_pyc: promotable.pycNumber,
            requester_email: newEmail, requester_gender: newGender, requested_members: newMembers
          }).eq('id', req.id);
          if (!pErr) roommateRequestsModified++;
        } else {
          const { error: cErr } = await supabase.from('roommate_requests').update({ status: 'Cancelled' }).eq('id', req.id);
          if (!cErr) roommateRequestsModified++;
        }
      }
      // Member of someone else's request
      const { data: allActive } = await supabase
        .from('roommate_requests').select('*').eq('status', 'Active');
      for (const req of (allActive || [])) {
        if (req.requester_pyc && req.requester_pyc.toUpperCase() === pyc) continue;
        const members = req.requested_members || [];
        if (!members.some(function(m) { return (m.pycNumber || '').toUpperCase() === pyc; })) continue;
        const filtered = members.filter(function(m) { return (m.pycNumber || '').toUpperCase() !== pyc; });
        const { error: mErr } = await supabase.from('roommate_requests').update({ requested_members: filtered }).eq('id', req.id);
        if (!mErr) roommateRequestsModified++;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        message: (res.registrant_name || 'Reservation') + ' marked as Volunteer' +
          (freedSpots > 0 ? '. Freed ' + freedSpots + ' dorm spot' + (freedSpots === 1 ? '' : 's') : '') +
          (roomsModified > 0 ? '. Removed from ' + roomsModified + ' room' + (roomsModified === 1 ? '' : 's') : '') +
          (roommateRequestsModified > 0 ? '. Updated ' + roommateRequestsModified + ' roommate request' + (roommateRequestsModified === 1 ? '' : 's') : '') +
          '.',
        freedSpots: freedSpots,
        cleanup: { roomsModified: roomsModified, roommateRequestsModified: roommateRequestsModified }
      })
    };
  } catch (err) {
    console.error('mark-volunteer error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
