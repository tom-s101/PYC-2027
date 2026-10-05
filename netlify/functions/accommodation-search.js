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

    const query = (parsed.query || '').trim().substring(0, 200);
    const searchType = parsed.searchType || 'name';

    if (!query || query.length < 2) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Search query required (min 2 characters)' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let results;

    if (searchType === 'email') {
      const { data } = await supabase
        .from('accommodation_reservations')
        .select('*')
        .ilike('registrant_email', `%${query}%`)
        .limit(50);
      results = data;
    } else if (searchType === 'id') {
      // Search by transaction reference or ID
      const { data } = await supabase
        .from('accommodation_reservations')
        .select('*')
        .or(`transaction_reference.ilike.%${query}%,id.eq.${query.substring(0, 50)}`)
        .limit(50);
      results = data;
    } else {
      const { data } = await supabase
        .from('accommodation_reservations')
        .select('*')
        .ilike('registrant_name', `%${query}%`)
        .limit(50);
      results = data;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, results: results || [] })
    };
  } catch (error) {
    console.error('Accommodation search error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
