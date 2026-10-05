const { createClient } = require('@supabase/supabase-js');

/**
 * Validates an admin session token.
 * Returns { valid: true, role: 'admin'|'checkin', username: '...' } or { valid: false }
 */
async function validateAdminSession(sessionToken) {
  if (!sessionToken) {
    console.warn('validateAdminSession: no token provided');
    return { valid: false };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { data: session, error } = await supabase
      .from('admin_sessions')
      .select('*')
      .eq('session_token', sessionToken)
      .single();

    if (error || !session) {
      console.warn('validateAdminSession: session not found, error:', error?.message);
      return { valid: false };
    }

    // Check expiration
    if (new Date(session.expires_at) < new Date()) {
      console.warn('validateAdminSession: session expired');
      await supabase
        .from('admin_sessions')
        .delete()
        .eq('session_token', sessionToken);
      return { valid: false };
    }

    return {
      valid: true,
      role: session.role || 'admin',
      username: session.username
    };
  } catch (err) {
    console.error('Session validation error:', err);
    return { valid: false };
  }
}

/**
 * Extracts session token from request.
 * Checks Authorization header (both cases), query params, and request body.
 */
function extractSessionToken(event) {
  // Netlify lowercases headers, but check both for safety
  var headers = event.headers || {};
  var authHeader = headers['authorization'] || headers['Authorization'] || '';
  if (authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Check query parameter
  var params = event.queryStringParameters || {};
  if (params.sessionToken) return params.sessionToken;

  // Check request body
  try {
    if (event.body) {
      var body = JSON.parse(event.body);
      if (body.sessionToken) return body.sessionToken;
    }
  } catch (e) {
    // Body might not be JSON
  }

  console.warn('extractSessionToken: no token found. Header keys:', Object.keys(headers).join(', '));
  return null;
}

/**
 * Returns a 401 response with CORS headers.
 */
function unauthorizedResponse(headers) {
  return {
    statusCode: 401,
    headers: headers || { 
      'Access-Control-Allow-Origin': '*', 
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS'
    },
    body: JSON.stringify({ error: 'Unauthorized. Valid admin session required.' })
  };
}

module.exports = { validateAdminSession, extractSessionToken, unauthorizedResponse };
