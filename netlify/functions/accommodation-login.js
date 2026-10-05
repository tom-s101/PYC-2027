const { createClient } = require('@supabase/supabase-js');

const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000;

exports.handler = async (event, context) => {
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const { username, password } = JSON.parse(event.body);
    if (!username || !password) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Username and password required' }) };
    }

    const clientIP = event.headers['x-forwarded-for'] || event.headers['client-ip'] || 'unknown';
    const attemptData = loginAttempts.get(clientIP) || { count: 0, lockedUntil: null };

    if (attemptData.lockedUntil && Date.now() < attemptData.lockedUntil) {
      const remaining = Math.ceil((attemptData.lockedUntil - Date.now()) / 60000);
      return { statusCode: 429, headers, body: JSON.stringify({ error: `Too many attempts. Try again in ${remaining} minutes.` }) };
    }

    if (attemptData.count >= MAX_ATTEMPTS) {
      loginAttempts.set(clientIP, { count: attemptData.count, lockedUntil: Date.now() + LOCKOUT_DURATION });
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Too many failed attempts. Locked for 15 minutes.' }) };
    }

    // Check accommodation volunteer credentials (separate from admin)
    // IMPORTANT: Set ACCOMM_USERNAME and ACCOMM_PASSWORD in Netlify environment variables
    const accommUser = process.env.ACCOMM_USERNAME;
    const accommPass = process.env.ACCOMM_PASSWORD;

    // Also allow admin credentials to access accommodation dashboard
    const adminUser = process.env.ADMIN_USERNAME;
    const adminPass = process.env.ADMIN_PASSWORD;

    const isAccommMatch = accommUser && accommPass && username === accommUser && password === accommPass;
    const isAdminMatch = adminUser && adminPass && username === adminUser && password === adminPass;

    if (isAccommMatch || isAdminMatch) {
      loginAttempts.delete(clientIP);

      // Generate session token
      const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
      let sessionToken = '';
      for (let i = 0; i < 64; i++) sessionToken += chars.charAt(Math.floor(Math.random() * chars.length));

      const expiresAt = Date.now() + (24 * 60 * 60 * 1000);

      // Store session
      try {
        const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
        await supabase.from('admin_sessions').insert({
          session_token: sessionToken,
          username: username,
          role: 'accommodation',
          ip_address: clientIP,
          expires_at: new Date(expiresAt).toISOString(),
          created_at: new Date().toISOString()
        });
      } catch (e) {
        console.error('Session store error:', e);
      }

      return {
        statusCode: 200, headers,
        body: JSON.stringify({ success: true, sessionToken, expiresAt, username, role: 'accommodation' })
      };
    } else {
      attemptData.count++;
      loginAttempts.set(clientIP, attemptData);
      return { statusCode: 401, headers, body: JSON.stringify({ success: false, message: 'Invalid credentials' }) };
    }
  } catch (error) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Internal server error' }) };
  }
};
