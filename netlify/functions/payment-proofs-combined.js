const { createClient } = require('@supabase/supabase-js');

// Returns dorm accommodation proofs + tent proofs combined, each labeled with type
// Query params: ?method=gcash|bank  &status=pending|resubmitted (optional)

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const qs = event.queryStringParameters || {};
    const method = (qs.method || 'gcash').toLowerCase(); // 'gcash' or 'bank'
    const status = (qs.status || 'pending').toLowerCase(); // 'pending' or 'resubmitted'

    // Determine target statuses and methods
    const statusFilter = status === 'resubmitted' ? ['Resubmitted'] : ['Pending Review'];

    // 1. Fetch dorm accommodation reservations (only those with proof uploaded)
    const { data: dormRes } = await supabase
      .from('accommodation_reservations')
      .select('*')
      .in('payment_status', statusFilter)
      .not('payment_proof_url', 'is', null)
      .order('payment_proof_uploaded_at', { ascending: true });

    // 2. Fetch tent reservations (with proofs uploaded)
    const { data: tentRes } = await supabase
      .from('tent_reservations')
      .select('*')
      .in('payment_status', statusFilter)
      .not('payment_proof_url', 'is', null)
      .order('payment_proof_uploaded_at', { ascending: true });

    // Filter by method
    const isGcash = function(m) { return (m || '').toLowerCase() === 'gcash'; };
    const isBank = function(m) { return (m || '').toLowerCase() === 'bank' || (m || '').toLowerCase() === 'bank transfer'; };
    const filterMethod = method === 'bank' ? isBank : isGcash;

    const dormFiltered = (dormRes || []).filter(function(r) { return filterMethod(r.payment_method); });
    const tentFiltered = (tentRes || []).filter(function(r) { return filterMethod(r.payment_method); });

    // Group dorm reservations by payment_proof_url + email (same upload = one card).
    // A user paying for boys dorm + girls dorm in one cart produces multiple rows
    // sharing the same proof URL. Admin should see ONE card with all reservations.
    const dormGroupsMap = {};
    dormFiltered.forEach(function(r) {
      // Group key: URL + email (URL alone could collide if URL is null/empty)
      const groupKey = (r.payment_proof_url || r.id) + '|' + (r.registrant_email || '');
      if (!dormGroupsMap[groupKey]) {
        dormGroupsMap[groupKey] = {
          id: r.id,
          ids: [],
          proof_type: 'dorm',
          registrant_name: r.registrant_name,
          registrant_email: r.registrant_email,
          payment_status: r.payment_status,
          payment_method: r.payment_method,
          payment_account: r.payment_account,
          transaction_reference: r.transaction_reference,
          payment_proof_url: r.payment_proof_url,
          payment_proof_uploaded_at: r.payment_proof_uploaded_at,
          total_amount: 0,
          total_spots: 0,
          reservation_count: 0,
          reservations: []
        };
      }
      const g = dormGroupsMap[groupKey];
      g.ids.push(r.id);
      g.total_amount += parseFloat(r.total_amount) || 0;
      g.total_spots += parseInt(r.spots_requested) || 0;
      g.reservation_count += 1;
      g.reservations.push({
        id: r.id,
        accommodation_type: r.accommodation_type,
        spots_requested: r.spots_requested,
        total_amount: r.total_amount,
        price_per_spot: r.price_per_spot
      });
    });
    const dormProofs = Object.values(dormGroupsMap);

    // For tent, group by group_id so we show one card per group (not per tent)
    const tentGroupsMap = {};
    tentFiltered.forEach(function(r) {
      const gid = r.group_id || r.id;
      if (!tentGroupsMap[gid]) {
        tentGroupsMap[gid] = {
          id: r.id,
          group_id: r.group_id,
          proof_type: 'tent',
          registrant_name: r.registrant_name,
          registrant_email: r.registrant_email,
          payment_status: r.payment_status,
          payment_method: r.payment_method,
          payment_account: r.payment_account,
          transaction_reference: r.transaction_reference,
          payment_proof_url: r.payment_proof_url,
          payment_proof_uploaded_at: r.payment_proof_uploaded_at,
          total_amount: 0,
          tent_count: 0,
          people_count: 0,
          tents: []
        };
      }
      const g = tentGroupsMap[gid];
      g.total_amount += parseFloat(r.total_amount) || 0;
      g.tent_count += 1;
      g.people_count += (r.members || []).length;
      g.tents.push({
        id: r.id,
        tent_size: r.tent_size,
        canopy_number: r.canopy_number,
        tent_group_type: r.tent_group_type || null,
        members: r.members,
        total_amount: r.total_amount
      });
    });
    const tentProofs = Object.values(tentGroupsMap);

    // Combine, sort by uploaded_at ascending (oldest first)
    const combined = dormProofs.concat(tentProofs).sort(function(a, b) {
      const ta = new Date(a.payment_proof_uploaded_at || 0).getTime();
      const tb = new Date(b.payment_proof_uploaded_at || 0).getTime();
      return ta - tb;
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, proofs: combined })
    };
  } catch (err) {
    console.error('Combined proofs error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
