const { createClient } = require('@supabase/supabase-js');

// Admin tool: look up a registrant by PYC (confirmation_number) and return the
// fields needed to pre-fill the volunteer reservation form: name, email, gender.
//
// Input (POST JSON): { pycNumber: 'PYC-0123' }
// Output:
//   { found: true, firstName, lastName, name, email, gender }  on hit
//   { found: false }                                            when not found

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    let parsed;
    try { parsed = JSON.parse(event.body); } catch (e) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid request' }) };
    }

    const pyc = String(parsed.pycNumber || '').trim().toUpperCase();
    if (!pyc) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'PYC number required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    const { data, error } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, gender')
      .eq('confirmation_number', pyc)
      .maybeSingle();

    if (error) {
      console.error('Lookup error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }

    if (!data) {
      return { statusCode: 200, headers, body: JSON.stringify({ found: false }) };
    }

    const fullName = ((data.first_name || '') + ' ' + (data.last_name || '')).trim();
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        found: true,
        registrationId: data.id,
        firstName: data.first_name || '',
        lastName: data.last_name || '',
        name: fullName,
        email: data.email || '',
        gender: data.gender || ''
      })
    };
  } catch (err) {
    console.error('lookup-by-pyc error:', err);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error: ' + err.message }) };
  }
};
