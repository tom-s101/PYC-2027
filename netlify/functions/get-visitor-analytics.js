const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
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
    // Get authorization header (try both cases)
    const authHeader = event.headers.authorization || event.headers.Authorization;
    
    console.log('Auth header present:', !!authHeader);
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.error('Missing or invalid authorization header');
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Unauthorized - Missing token' })
      };
    }

    const sessionToken = authHeader.substring(7);
    console.log('Session token length:', sessionToken.length);

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Validate session - using select without .single()
    console.log('Looking up session...');
    const { data: sessions, error: sessionError } = await supabase
      .from('admin_sessions')
      .select('*')
      .eq('session_token', sessionToken);

    console.log('Session lookup result:', { 
      found: sessions?.length,
      error: sessionError?.message 
    });

    if (sessionError) {
      console.error('Database error:', sessionError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Database error', details: sessionError.message })
      };
    }

    if (!sessions || sessions.length === 0) {
      console.error('No session found with this token');
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid session - not found in database' })
      };
    }

    const session = sessions[0];
    console.log('Session found:', {
      username: session.username,
      role: session.role,
      expires: session.expires_at
    });

    // Check if session expired
    const now = new Date();
    const expiresAt = new Date(session.expires_at);
    
    if (expiresAt < now) {
      console.error('Session expired:', { expiresAt, now });
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Session expired' })
      };
    }

    // Check if user has admin role
    if (session.role !== 'admin') {
      console.error('User does not have admin role:', session.role);
      return {
        statusCode: 403,
        headers,
        body: JSON.stringify({ error: 'Forbidden - Admin access required' })
      };
    }

    console.log('Session valid! Fetching visitors...');

    // Fetch all visitors
    const { data: visitors, error: visitorsError } = await supabase
      .from('visitor_analytics')
      .select('*')
      .order('visited_at', { ascending: false });

    if (visitorsError) {
      console.error('Error fetching visitors:', visitorsError);
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Failed to fetch analytics', details: visitorsError.message })
      };
    }

    console.log(`Found ${visitors ? visitors.length : 0} visitors`);

    // Process all visitors (even those with NULL location data)
    const validVisitors = visitors || [];
    
    // Calculate statistics
    const totalVisitors = validVisitors.length;
    
    // Count Philippines visitors
    const philippinesVisitors = validVisitors.filter(v => 
      v.country === 'Philippines' || v.country === 'PH'
    ).length;
    
    // Count international visitors
    const internationalVisitors = validVisitors.filter(v => 
      v.country && v.country !== 'Philippines' && v.country !== 'PH'
    ).length;
    
    // Count visitors WITHOUT location data
    const unknownLocationVisitors = validVisitors.filter(v => !v.country).length;
    
    // Unique countries (excluding null)
    const countries = new Set(validVisitors.filter(v => v.country).map(v => v.country));
    const uniqueCountries = countries.size;

    // Calculate today's visitors
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayVisitors = validVisitors.filter(v => new Date(v.visited_at) >= today).length;

    // Calculate this week's visitors
    const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const weekVisitors = validVisitors.filter(v => new Date(v.visited_at) >= weekAgo).length;

    // Get top countries (excluding null)
    const countryCount = {};
    validVisitors.forEach(v => {
      if (v.country) {
        countryCount[v.country] = (countryCount[v.country] || 0) + 1;
      }
    });
    
    const topCountries = Object.entries(countryCount)
      .map(([country, count]) => ({ country, count }))
      .sort((a, b) => b.count - a.count);

    // Get recent visitors (last 100)
    const recentVisitors = validVisitors.slice(0, 100);

    const result = {
      totalVisitors,
      philippinesVisitors,
      internationalVisitors,
      unknownLocationVisitors,
      uniqueCountries,
      todayVisitors,
      weekVisitors,
      topCountries,
      visitors: validVisitors,
      recentVisitors
    };

    console.log('Returning analytics:', {
      totalVisitors,
      philippinesVisitors,
      internationalVisitors,
      unknownLocationVisitors,
      todayVisitors,
      weekVisitors
    });

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(result)
    };

  } catch (error) {
    console.error('Unexpected error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        error: 'Internal server error',
        message: error.message
      })
    };
  }
};
