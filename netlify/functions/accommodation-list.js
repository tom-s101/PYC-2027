const { createClient } = require('@supabase/supabase-js');

const VALID_FILTERS = ['all', 'pending_review', 'resubmitted', 'paid', 'pending', 'rejected'];

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    
    const rawFilter = (event.queryStringParameters?.filter || 'all').toLowerCase();
    const filter = VALID_FILTERS.includes(rawFilter) ? rawFilter : 'all';

    let query = supabase
      .from('accommodation_reservations')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(500);

    if (filter === 'pending_review') query = query.eq('payment_status', 'Pending Review');
    else if (filter === 'resubmitted') query = query.eq('payment_status', 'Resubmitted');
    else if (filter === 'paid') query = query.eq('payment_status', 'Paid');
    else if (filter === 'pending') query = query.eq('payment_status', 'Pending');
    else if (filter === 'rejected') query = query.eq('payment_status', 'Rejected');

    const { data, error } = await query;
    if (error) {
      console.error('List error:', error.message);
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, reservations: data || [] }) };
  } catch (error) {
    console.error('Accommodation list error:', error.message);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server error' }) };
  }
};
