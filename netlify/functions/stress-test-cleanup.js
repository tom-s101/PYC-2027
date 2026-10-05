const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const body = JSON.parse(event.body || '{}');
    if (!body.confirm) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Confirmation required' }) };

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    let regDeleted = 0;
    let accommDeleted = 0;

    // Step 1: Count test registrations first
    const { data: regRows, error: regCountErr } = await supabase
      .from('registrations')
      .select('id')
      .ilike('last_name', '%STRESSTEST-%');

    if (regCountErr) {
      console.error('Reg count error:', regCountErr.message);
    } else if (regRows && regRows.length > 0) {
      const ids = regRows.map(r => r.id);
      // Delete in batches of 100
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { error: delErr } = await supabase
          .from('registrations')
          .delete()
          .in('id', batch);
        if (delErr) {
          console.error('Reg delete batch error:', delErr.message);
        } else {
          regDeleted += batch.length;
        }
      }
    }

    // Step 2: Count test accommodation reservations
    const { data: accommRows, error: accommCountErr } = await supabase
      .from('accommodation_reservations')
      .select('id')
      .ilike('registrant_name', '%STRESSTEST-%');

    if (accommCountErr) {
      console.error('Accomm count error:', accommCountErr.message);
    } else if (accommRows && accommRows.length > 0) {
      const ids = accommRows.map(r => r.id);
      for (let i = 0; i < ids.length; i += 100) {
        const batch = ids.slice(i, i + 100);
        const { error: delErr } = await supabase
          .from('accommodation_reservations')
          .delete()
          .in('id', batch);
        if (delErr) {
          console.error('Accomm delete batch error:', delErr.message);
        } else {
          accommDeleted += batch.length;
        }
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        registrationsDeleted: regDeleted,
        accommodationsDeleted: accommDeleted
      })
    };
  } catch (error) {
    console.error('Cleanup error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message, success: false }) };
  }
};
