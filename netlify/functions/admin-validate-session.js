const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const { sessionToken } = JSON.parse(event.body);

    if (!sessionToken) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Session token required' })
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Check session in database
    const { data: session, error } = await supabase
      .from('admin_sessions')
      .select('*')
      .eq('session_token', sessionToken)
      .single();

    if (error || !session) {
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ 
          valid: false,
          error: 'Invalid session' 
        })
      };
    }

    // Check if session has expired
    const expiresAt = new Date(session.expires_at).getTime();
    if (Date.now() > expiresAt) {
      // Delete expired session
      await supabase
        .from('admin_sessions')
        .delete()
        .eq('session_token', sessionToken);

      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ 
          valid: false,
          error: 'Session expired' 
        })
      };
    }

    // Session is valid - return with role
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        valid: true,
        username: session.username,
        role: session.role || 'admin', // Default to admin for backward compatibility
        expiresAt: session.expires_at
      })
    };

  } catch (error) {
    console.error('Session validation error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        valid: false,
        error: 'Validation failed'
      })
    };
  }
};
