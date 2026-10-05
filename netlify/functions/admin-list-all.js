const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Supabase/PostgREST returns at most 1000 rows per request. A plain select('*')
    // therefore SILENTLY drops everyone past the first 1000 — which previously caused
    // registrations to be missing from the dashboard, export, stats, and counter.
    // We page through in batches until we've fetched every row.
    const PAGE = 1000;
    let all = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('registrations')
        .select('*')
        .order('created_at', { ascending: false })
        .range(from, from + PAGE - 1);

      if (error) {
        console.error('List all error:', error);
        throw new Error('Failed to fetch registrations: ' + error.message);
      }

      const batch = data || [];
      all = all.concat(batch);

      // Stop when the last page returned fewer than a full page (no more rows).
      if (batch.length < PAGE) break;
      from += PAGE;

      // Hard safety stop (well above any realistic registration count) to avoid an
      // infinite loop if something unexpected happens.
      if (from > 100000) break;
    }

    return {
      statusCode: 200,
      body: JSON.stringify(all)
    };

  } catch (error) {
    console.error('Admin list all error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch registrations',
        message: error.message
      })
    };
  }
};
