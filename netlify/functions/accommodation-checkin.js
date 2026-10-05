const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    if (event.body && event.body.length > 2000) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request too large' }) };
    }

    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const { action, reservationId, roomAssignment } = parsed;
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Action: search
    if (action === 'search') {
      const query = (parsed.query || '').trim().substring(0, 200);
      const searchType = parsed.searchType || 'name';

      if (!query || query.length < 2) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Search query required (min 2 characters)' }) };
      }

      let results;
      if (searchType === 'email') {
        const { data } = await supabase
          .from('accommodation_reservations')
          .select('*')
          .ilike('registrant_email', `%${query}%`)
          .not('payment_status', 'in', '("Cancelled","Rejected")')
          .order('created_at', { ascending: false })
          .limit(50);
        results = data;
      } else if (searchType === 'ref') {
        const { data } = await supabase
          .from('accommodation_reservations')
          .select('*')
          .ilike('transaction_reference', `%${query}%`)
          .not('payment_status', 'in', '("Cancelled","Rejected")')
          .order('created_at', { ascending: false })
          .limit(50);
        results = data;
      } else {
        const { data } = await supabase
          .from('accommodation_reservations')
          .select('*')
          .ilike('registrant_name', `%${query}%`)
          .not('payment_status', 'in', '("Cancelled","Rejected")')
          .order('created_at', { ascending: false })
          .limit(50);
        results = data;
      }

      // Get type display names
      const { data: types } = await supabase.from('accommodation_types').select('id, display_name');
      const typeMap = {};
      (types || []).forEach(t => { typeMap[t.id] = t.display_name; });

      const enriched = (results || []).map(r => ({
        ...r,
        accommodation_display: typeMap[r.accommodation_type] || r.accommodation_type
      }));

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, results: enriched }) };
    }

    // Action: all_reservations
    // Returns a lightweight list of every active reservation (paginated past the
    // 1000-row cap) so the room map can mark who is checked in. Only the fields the
    // map needs are selected to keep the payload small.
    if (action === 'all_reservations') {
      const PAGE = 1000;
      let all = [];
      let from = 0;
      while (true) {
        const { data, error } = await supabase
          .from('accommodation_reservations')
          .select('id, registration_id, registrant_name, registrant_email, accommodation_type, spots_requested, payment_status, checked_in, room_assignment')
          .not('payment_status', 'in', '("Cancelled","Rejected")')
          .range(from, from + PAGE - 1);
        if (error) {
          return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to fetch reservations' }) };
        }
        const batch = data || [];
        all = all.concat(batch);
        if (batch.length < PAGE) break;
        from += PAGE;
        if (from > 100000) break;
      }
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, results: all }) };
    }

    // Action: checkin / undo
    if (action === 'checkin' || action === 'undo') {
      if (!reservationId || typeof reservationId !== 'string' || reservationId.length > 50) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Valid reservation ID required' }) };
      }

      const isCheckin = action === 'checkin';
      const updateData = {
        checked_in: isCheckin,
        checked_in_at: isCheckin ? new Date().toISOString() : null,
        updated_at: new Date().toISOString()
      };

      // Optional room assignment
      if (isCheckin && roomAssignment && typeof roomAssignment === 'string') {
        updateData.room_assignment = roomAssignment.substring(0, 50);
      }
      if (!isCheckin) {
        updateData.room_assignment = null;
      }

      const { data: record, error: updateErr } = await supabase
        .from('accommodation_reservations')
        .update(updateData)
        .eq('id', reservationId)
        .select()
        .single();

      if (updateErr) {
        console.error('Check-in error:', updateErr.message);
        return { statusCode: 500, headers, body: JSON.stringify({ error: 'Check-in failed' }) };
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: isCheckin ? 'Checked in successfully!' : 'Check-in undone',
          record
        })
      };
    }

    // Action: stats
    if (action === 'stats') {
      const { data: types } = await supabase.from('accommodation_types').select('*').eq('is_active', true);
      const { data: reservations } = await supabase
        .from('accommodation_reservations')
        .select('accommodation_type, spots_requested, payment_status, checked_in')
        .not('payment_status', 'in', '("Cancelled","Rejected")');

      const stats = (types || []).map(t => {
        const typeRes = (reservations || []).filter(r => r.accommodation_type === t.id);
        const confirmed = typeRes.filter(r => r.payment_status === 'Paid');
        const checkedIn = typeRes.filter(r => r.checked_in === true && r.payment_status === 'Paid');
        const confirmedSpots = confirmed.reduce((s, r) => s + (r.spots_requested || 1), 0);
        const checkedInSpots = checkedIn.reduce((s, r) => s + (r.spots_requested || 1), 0);
        const pendingSpots = typeRes.filter(r => r.payment_status !== 'Paid').reduce((s, r) => s + (r.spots_requested || 1), 0);

        return {
          id: t.id,
          display_name: t.display_name,
          total_capacity: t.total_units * (t.capacity_per_unit || 1),
          confirmed_spots: confirmedSpots,
          checked_in_spots: checkedInSpots,
          not_checked_in_spots: confirmedSpots - checkedInSpots,
          pending_spots: pendingSpots,
          occupancy_pct: t.total_units * (t.capacity_per_unit || 1) > 0
            ? Math.round((confirmedSpots / (t.total_units * (t.capacity_per_unit || 1))) * 100) : 0
        };
      });

      const totals = {
        total_confirmed: stats.reduce((s, b) => s + b.confirmed_spots, 0),
        total_checked_in: stats.reduce((s, b) => s + b.checked_in_spots, 0),
        total_not_checked_in: stats.reduce((s, b) => s + b.not_checked_in_spots, 0),
        total_capacity: stats.reduce((s, b) => s + b.total_capacity, 0)
      };

      return { statusCode: 200, headers, body: JSON.stringify({ success: true, stats, totals }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid action' }) };
  } catch (error) {
    console.error('Accommodation checkin error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
