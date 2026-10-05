const { createClient } = require('@supabase/supabase-js');

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

    const { data: requests, error } = await supabase
      .from('roommate_requests')
      .select('*')
      .eq('status', 'Active')
      .order('created_at', { ascending: false });

    if (error) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Failed to load requests.' }) };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true, requests: requests || [] })
    };
  } catch (err) {
    console.error('Get roommate requests error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error.' }) };
  }
};
