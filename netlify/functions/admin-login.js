const { createClient } = require('@supabase/supabase-js');

// Rate limiting storage (in-memory - resets on function cold start)
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes

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
    const { username, password } = JSON.parse(event.body);

    if (!username || !password) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Username and password required' })
      };
    }

    const clientIP = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    
    const attemptData = loginAttempts.get(clientIP) || { count: 0, lockedUntil: null };
    
    if (attemptData.lockedUntil && Date.now() < attemptData.lockedUntil) {
      const remainingTime = Math.ceil((attemptData.lockedUntil - Date.now()) / 60000);
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: 'Too many login attempts',
          message: `Account locked. Please try again in ${remainingTime} minutes.`,
          lockedUntil: attemptData.lockedUntil
        })
      };
    }

    if (attemptData.count >= MAX_ATTEMPTS) {
      const lockedUntil = Date.now() + LOCKOUT_DURATION;
      loginAttempts.set(clientIP, { count: attemptData.count, lockedUntil });
      
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: 'Too many login attempts',
          message: 'Too many failed attempts. Account locked for 15 minutes.',
          lockedUntil
        })
      };
    }

    // Simple credential check
    let userRole = null;
    let isValid = false;

    if (username === process.env.ADMIN_USERNAME && password === process.env.ADMIN_PASSWORD) {
      userRole = 'admin';
      isValid = true;
    } else if (process.env.CHECKIN_USERNAME && process.env.CHECKIN_PASSWORD && 
               username === process.env.CHECKIN_USERNAME && password === process.env.CHECKIN_PASSWORD) {
      userRole = 'checkin';
      isValid = true;
    }

    if (isValid) {
      loginAttempts.delete(clientIP);
      
      const sessionToken = generateSessionToken();
      const expiresAt = Date.now() + (24 * 60 * 60 * 1000);

      const supabase = createClient(
        process.env.SUPABASE_URL,
        process.env.SUPABASE_SERVICE_KEY
      );

      const { error: sessionError } = await supabase
        .from('admin_sessions')
        .insert({
          session_token: sessionToken,
          username: username,
          role: userRole,
          ip_address: clientIP,
          expires_at: new Date(expiresAt).toISOString(),
          created_at: new Date().toISOString()
        });

      if (sessionError) {
        console.error('Session creation error:', sessionError);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          sessionToken,
          expiresAt,
          username,
          role: userRole
        })
      };

    } else {
      attemptData.count++;
      loginAttempts.set(clientIP, attemptData);

      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({
          success: false,
          message: 'Invalid username or password'
        })
      };
    }

  } catch (error) {
    console.error('Login error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

function generateSessionToken() {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let token = '';
  for (let i = 0; i < 64; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
