const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  // Add CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Get all registrations that have been resubmitted
    // These are registrations that were Rejected and now have a new payment_proof_url and are Pending
    const { data: resubmissions, error } = await supabase
      .from('registrations')
      .select('*')
      .eq('payment_status', 'Resubmitted')
      .not('payment_proof_url', 'is', null)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('Fetch error:', error);
      throw new Error('Failed to fetch resubmissions: ' + error.message);
    }

    // Filter to only show ones that likely were resubmitted (had a previous rejection)
    // For now, we'll show all Pending with payment proofs
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        resubmissions: resubmissions || []
      })
    };

  } catch (error) {
    console.error('Get resubmissions error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to fetch resubmissions',
        message: error.message
      })
    };
  }
};
