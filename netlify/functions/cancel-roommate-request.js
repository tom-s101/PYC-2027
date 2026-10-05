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
    const { registrationId, pycNumber } = parsed;

    if (!registrationId && !pycNumber) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Registration ID or PYC number required.' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Find active request by this person — must match BOTH the requester_registration_id AND requester_pyc
    // to ensure only the actual requester can cancel their own request
    let query = supabase.from('roommate_requests').select('*').eq('status', 'Active');

    if (registrationId) {
      query = query.eq('requester_registration_id', registrationId);
    }
    if (pycNumber) {
      query = query.eq('requester_pyc', pycNumber.toUpperCase());
    }

    const { data: requests } = await query;

    if (!requests || requests.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: 'No active roommate request found for your account.' }) };
    }

    // Extra safety: verify the registration ID matches what's in the request
    const req = requests[0];
    if (registrationId && req.requester_registration_id !== registrationId) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'You can only cancel your own roommate request.' }) };
    }

    // Cancel the request
    const { error: updateErr } = await supabase
      .from('roommate_requests')
      .update({ status: 'Cancelled', updated_at: new Date().toISOString() })
      .eq('id', req.id);

    if (updateErr) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to cancel request.' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, message: 'Roommate request cancelled.' })
    };
  } catch (err) {
    console.error('Cancel roommate request error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error.' }) };
  }
};
