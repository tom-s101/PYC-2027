const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data, error } = await supabase
      .from('accommodation_waitlist')
      .select('id, registrant_name, registrant_email, accommodation_type, spots_requested, status, created_at, notified_expires_at')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Waitlist query error:', error);
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: error.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, waitlist: data || [] }) };
  } catch (err) {
    console.error('Waitlist list error:', err);
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
