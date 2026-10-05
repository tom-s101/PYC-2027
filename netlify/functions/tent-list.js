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
      .from('tent_reservations')
      .select('id, registration_id, registrant_name, registrant_email, tent_size, members, canopy_number, tent_group_type, status, created_at, group_id, payment_status, payment_method, payment_account, transaction_reference, payment_proof_url, payment_proof_uploaded_at, total_amount, price_per_person, rejection_reason')
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Tent list error:', error.message);
      return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: error.message }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, tents: data || [] }) };
  } catch (err) {
    console.error('Tent list error:', err.message);
    return { statusCode: 200, headers, body: JSON.stringify({ success: false, error: err.message }) };
  }
};
