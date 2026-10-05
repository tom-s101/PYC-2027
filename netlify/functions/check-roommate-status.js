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
    const registrationId = parsed.registrationId || '';

    if (!pycNumber) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'PYC number required.' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Check if this person has made their own request
    const { data: ownRequest } = await supabase
      .from('roommate_requests')
      .select('*')
      .eq('requester_pyc', pycNumber)
      .eq('status', 'Active');

    if (ownRequest && ownRequest.length > 0) {
      const req = ownRequest[0];
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          hasOwnRequest: true,
          requestId: req.id,
          requestedMembers: req.requested_members,
          requestedBy: null,
          requesterName: null
        })
      };
    }

    // Check if this person has been requested by someone else
    const { data: allRequests } = await supabase
      .from('roommate_requests')
      .select('*')
      .eq('status', 'Active');

    let requestedBy = null;
    let requesterName = null;
    let requestedMembers = null;
    let requestId = null;

    if (allRequests) {
      for (const req of allRequests) {
        const members = Array.isArray(req.requested_members) ? req.requested_members : [];
        for (const m of members) {
          if (m.pycNumber && m.pycNumber.toUpperCase() === pycNumber) {
            requestedBy = req.requester_pyc;
            requesterName = req.requester_name;
            requestedMembers = members;
            requestId = req.id;
            break;
          }
        }
        if (requestedBy) break;
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        hasOwnRequest: false,
        requestId: requestId,
        requestedBy: requestedBy,
        requesterName: requesterName,
        requestedMembers: requestedMembers
      })
    };
  } catch (err) {
    console.error('Check roommate status error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error.' }) };
  }
};
