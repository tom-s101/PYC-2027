const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const { query, searchType } = JSON.parse(event.body);

    if (!query || query.trim() === '') {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Search query required' }) };
    }

    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const searchTerm = query.trim();
    let data, error;

    // === EMAIL SEARCH ===
    if (searchType === 'email' || searchTerm.includes('@')) {
      ({ data, error } = await supabase
        .from('registrations')
        .select('*')
        .ilike('email', `%${searchTerm}%`)
        .order('created_at', { ascending: false })
        .limit(50));

    // === CONFIRMATION / ID SEARCH ===
    } else if (searchType === 'confirmation') {
      // Try PYC-XXXX confirmation number first
      if (searchTerm.match(/^PYC-/i)) {
        ({ data, error } = await supabase
          .from('registrations')
          .select('*')
          .ilike('confirmation_number', `%${searchTerm}%`)
          .order('created_at', { ascending: false })
          .limit(50));
      }

      // Try UUID match
      if ((!data || data.length === 0) && searchTerm.match(/^[0-9a-f]{8}-/i)) {
        ({ data, error } = await supabase
          .from('registrations')
          .select('*')
          .eq('id', searchTerm)
          .limit(10));
      }

      // If no UUID match or no results, try transaction_reference
      if (!data || data.length === 0) {
        try {
          const result = await supabase
            .from('registrations')
            .select('*')
            .ilike('transaction_reference', `%${searchTerm}%`)
            .order('created_at', { ascending: false })
            .limit(50);
          if (!result.error && result.data && result.data.length > 0) {
            data = result.data;
            error = null;
          }
        } catch (e) {
          // transaction_reference column may not exist yet
        }
      }

      // Still nothing? Try confirmation_number partial match
      if (!data || data.length === 0) {
        try {
          const result = await supabase
            .from('registrations')
            .select('*')
            .ilike('confirmation_number', `%${searchTerm}%`)
            .order('created_at', { ascending: false })
            .limit(50);
          if (!result.error && result.data && result.data.length > 0) {
            data = result.data;
            error = null;
          }
        } catch (e) {}
      }

      // Still nothing? Try partial ID text match
      if (!data || data.length === 0) {
        ({ data, error } = await supabase
          .from('registrations')
          .select('*')
          .ilike('id', `%${searchTerm}%`)
          .order('created_at', { ascending: false })
          .limit(50));
      }

    // === UUID SEARCH ===
    } else if (searchTerm.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)) {
      ({ data, error } = await supabase
        .from('registrations')
        .select('*')
        .eq('id', searchTerm)
        .limit(10));

    // === NAME SEARCH ===
    } else {
      const parts = searchTerm.split(/\s+/).filter(p => p.length > 0);

      if (parts.length >= 2) {
        // "John Smith" -> search first_name~John AND last_name~Smith, also reversed
        const firstName = parts[0];
        const lastName = parts.slice(1).join(' ');
        ({ data, error } = await supabase
          .from('registrations')
          .select('*')
          .or(`and(first_name.ilike.%${firstName}%,last_name.ilike.%${lastName}%),and(first_name.ilike.%${lastName}%,last_name.ilike.%${firstName}%)`)
          .order('created_at', { ascending: false })
          .limit(50));

        // If no results with AND, try broader OR
        if ((!data || data.length === 0) && !error) {
          ({ data, error } = await supabase
            .from('registrations')
            .select('*')
            .or(`first_name.ilike.%${firstName}%,last_name.ilike.%${lastName}%,first_name.ilike.%${lastName}%,last_name.ilike.%${firstName}%`)
            .order('created_at', { ascending: false })
            .limit(50));
        }
      } else {
        // Single word: search both first_name and last_name
        ({ data, error } = await supabase
          .from('registrations')
          .select('*')
          .or(`first_name.ilike.%${searchTerm}%,last_name.ilike.%${searchTerm}%`)
          .order('created_at', { ascending: false })
          .limit(50));
      }
    }

    if (error) {
      console.error('Search error:', error);
      throw new Error('Search failed: ' + error.message);
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ results: data || [], count: data ? data.length : 0 })
    };

  } catch (error) {
    console.error('Admin search error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Search failed', message: error.message }) };
  }
};
