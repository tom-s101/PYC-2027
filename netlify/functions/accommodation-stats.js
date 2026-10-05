const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Content-Type', 'Content-Type': 'application/json' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Get all accommodation types
    const { data: types, error: typesErr } = await supabase
      .from('accommodation_types')
      .select('*')
      .eq('is_active', true);
    if (typesErr) throw typesErr;

    // Get all reservations
    const { data: reservations, error: resErr } = await supabase
      .from('accommodation_reservations')
      .select('accommodation_type, spots_requested, payment_status, checked_in')
      .not('payment_status', 'eq', 'Cancelled');
    if (resErr) throw resErr;

    // Get waitlist counts
    let waitlistData = [];
    try {
      const { data: wl } = await supabase
        .from('accommodation_waitlist')
        .select('accommodation_type, spots_requested, status')
        .in('status', ['Waiting', 'Notified']);
      waitlistData = wl || [];
    } catch (e) { /* waitlist table may not exist yet */ }

    // Build detailed stats per accommodation type
    const breakdown = (types || []).map(t => {
      const typeRes = (reservations || []).filter(r => r.accommodation_type === t.id);
      const confirmed = typeRes.filter(r => r.payment_status === 'Paid');
      const pendingReview = typeRes.filter(r => r.payment_status === 'Pending Review');
      const pendingPayment = typeRes.filter(r => r.payment_status === 'Pending');
      const resubmitted = typeRes.filter(r => r.payment_status === 'Resubmitted');

      const confirmedSpots = confirmed.reduce((s, r) => s + (r.spots_requested || 1), 0);
      const pendingReviewSpots = pendingReview.reduce((s, r) => s + (r.spots_requested || 1), 0);
      const pendingPaymentSpots = pendingPayment.reduce((s, r) => s + (r.spots_requested || 1), 0);
      const resubmittedSpots = resubmitted.reduce((s, r) => s + (r.spots_requested || 1), 0);
      const contingentSpots = pendingReviewSpots + pendingPaymentSpots + resubmittedSpots;

      const totalCapacity = t.total_units * (t.capacity_per_unit || 1);
      const freeSpots = Math.max(0, totalCapacity - confirmedSpots - contingentSpots);

      const totalRooms = t.total_units;
      const spotsPerRoom = t.capacity_per_unit || 1;
      const confirmedRooms = Math.ceil(confirmedSpots / spotsPerRoom);
      const contingentRooms = Math.ceil(contingentSpots / spotsPerRoom);
      const freeRooms = Math.max(0, totalRooms - confirmedRooms - contingentRooms);

      const typeWaitlist = waitlistData.filter(w => w.accommodation_type === t.id);
      const waitingCount = typeWaitlist.filter(w => w.status === 'Waiting').length;
      const notifiedCount = typeWaitlist.filter(w => w.status === 'Notified').length;

      return {
        id: t.id,
        display_name: t.display_name,
        total_capacity: totalCapacity,
        total_rooms: totalRooms,
        spots_per_room: spotsPerRoom,
        confirmed_spots: confirmedSpots,
        pending_review_spots: pendingReviewSpots,
        pending_payment_spots: pendingPaymentSpots,
        resubmitted_spots: resubmittedSpots,
        contingent_spots: contingentSpots,
        free_spots: freeSpots,
        confirmed_rooms: confirmedRooms,
        contingent_rooms: contingentRooms,
        free_rooms: freeRooms,
        waitlist_waiting: waitingCount,
        waitlist_notified: notifiedCount,
        occupancy_pct: totalCapacity > 0 ? Math.round((confirmedSpots / totalCapacity) * 100) : 0,
        checked_in_spots: confirmed.filter(r => r.checked_in === true).reduce((s, r) => s + (r.spots_requested || 1), 0),
        not_checked_in_spots: confirmedSpots - confirmed.filter(r => r.checked_in === true).reduce((s, r) => s + (r.spots_requested || 1), 0)
      };
    });

    // Totals
    const totalRes = (reservations || []).length;
    const totalConfirmed = breakdown.reduce((s, b) => s + b.confirmed_spots, 0);
    const totalContingent = breakdown.reduce((s, b) => s + b.contingent_spots, 0);
    const totalCapacity = breakdown.reduce((s, b) => s + b.total_capacity, 0);
    const totalFree = breakdown.reduce((s, b) => s + b.free_spots, 0);
    const totalCheckedIn = breakdown.reduce((s, b) => s + (b.checked_in_spots || 0), 0);
    const totalNotCheckedIn = breakdown.reduce((s, b) => s + (b.not_checked_in_spots || 0), 0);
    const totalWaiting = waitlistData.filter(w => w.status === 'Waiting').length;
    const totalNotified = waitlistData.filter(w => w.status === 'Notified').length;

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        totalReservations: totalRes,
        totalConfirmed,
        totalContingent,
        totalCapacity,
        totalFree,
        totalWaiting,
        totalNotified,
        totalCheckedIn,
        totalNotCheckedIn,
        breakdown
      })
    };
  } catch (error) {
    console.error('Accommodation stats error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
