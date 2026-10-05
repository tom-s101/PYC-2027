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
    const { sessionToken } = JSON.parse(event.body || '{}');
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Validate admin session
    if (!sessionToken) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session token required' }) };

    const { data: session, error: sessionError } = await supabase
      .from('admin_sessions').select('*').eq('session_token', sessionToken).single();

    if (sessionError || !session || Date.now() > new Date(session.expires_at).getTime()) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Invalid or expired session' }) };
    }

    // 72 hours ago
    const cutoff = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();

    // Find stale: Pending status, no payment proof, older than 72h
    const { data: stale, error: fetchError } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, email, created_at, group_id')
      .eq('payment_status', 'Pending')
      .is('payment_proof_url', null)
      .lt('created_at', cutoff);

    if (fetchError) throw new Error('Fetch error: ' + fetchError.message);
    if (!stale || stale.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, deleted: 0, message: 'No stale registrations found' }) };
    }

    // Protect groups where ANY member has payment activity
    const groupIds = [...new Set(stale.filter(r => r.group_id).map(r => r.group_id))];
    const protectedGroupIds = new Set();
    for (const gid of groupIds) {
      const { data: gm } = await supabase.from('registrations').select('payment_status, payment_proof_url').eq('group_id', gid);
      if (gm && gm.some(m => m.payment_proof_url || m.payment_status !== 'Pending')) protectedGroupIds.add(gid);
    }

    const toDelete = stale.filter(r => !(r.group_id && protectedGroupIds.has(r.group_id)));
    if (toDelete.length === 0) {
      return { statusCode: 200, headers, body: JSON.stringify({ success: true, deleted: 0, skipped: stale.length, message: 'All stale records have group payment activity' }) };
    }

    const { error: deleteError } = await supabase.from('registrations').delete().in('id', toDelete.map(r => r.id));
    if (deleteError) throw new Error('Delete error: ' + deleteError.message);

    const summary = toDelete.map(r => r.first_name + ' ' + r.last_name + ' (' + r.email + ')');
    console.log('Cleaned up', toDelete.length, 'stale registrations:', summary);

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, deleted: toDelete.length, skipped: stale.length - toDelete.length, deletedRecords: summary }) };
  } catch (error) {
    console.error('Cleanup error:', error);
    return { statusCode: 500, headers, body: JSON.stringify({ error: error.message }) };
  }
};
