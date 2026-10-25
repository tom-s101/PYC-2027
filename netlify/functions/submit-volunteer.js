const { createClient } = require('@supabase/supabase-js');
const SibApiV3Sdk = require('sib-api-v3-sdk');

// ============================================================================
// Volunteer sign-up (public/volunteer.html → this function).
// Saves one row to `volunteer_applications` (see add-volunteer-applications-table.sql),
// then sends a Telegram ping to the team and a confirmation email (both non-fatal).
// Self-contained on purpose: Netlify bundles each function separately.
// ============================================================================

const AGES = ['14-17', '18-25', '26-35', '36+'];
const GENDERS = ['Male', 'Female'];
const ROLES = {
  registration: 'Registration & Check-in', ushering: 'Ushering & Crowd Care', media: 'Media & Photography',
  worship: 'Music & Worship', tech: 'Tech, Sound & Lights', hospitality: 'Hospitality & Meals',
  prayer: 'Prayer Team', firstaid: 'First Aid & Medical', logistics: 'Logistics & Setup', kids: 'Children & Teens'
};
const DAYS = { jun1: 'Tue June 1 (setup)', jun2: 'Wed June 2', jun3: 'Thu June 3', jun4: 'Fri June 4', jun5: 'Sat June 5', jun6: 'Sun June 6' };
const PH_REGIONS = ['Luzon', 'Visayas', 'Mindanao'];

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};
function reply(statusCode, body) { return { statusCode, headers, body: JSON.stringify(body) }; }
function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max || 200) : ''; }
function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function normalizePyc(v) {
  const digits = String(v || '').replace(/\D/g, '');
  return digits ? 'PYC-' + String(parseInt(digits, 10)).padStart(4, '0') : null;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  let b;
  try { b = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Invalid request.' }); }

  // Spam trap: real people never see or fill the "website" field.
  if (str(b.website)) return reply(200, { success: true });

  const v = {
    first_name: str(b.firstName, 100),
    last_name: str(b.lastName, 100),
    age: str(b.age, 10),
    gender: str(b.gender, 10),
    email: str(b.email, 254).toLowerCase(),
    phone: str(b.phone, 40),
    location_type: str(b.locationType, 20),
    region: null, city: null, country: null,
    home_church: str(b.homeChurch, 150),
    pyc_number: normalizePyc(b.pycNumber),
    roles: Array.isArray(b.roles) ? b.roles.filter(r => ROLES[r]).slice(0, 10) : [],
    availability: Array.isArray(b.days) ? b.days.filter(d => DAYS[d]).slice(0, 6) : [],
    experience: str(b.experience, 1000) || null,
    motivation: str(b.motivation, 1000) || null,
    guardian_consent: b.guardianConsent === true,
    status: 'New'
  };

  const errors = [];
  if (!v.first_name || !v.last_name) errors.push('Your name is required.');
  if (!AGES.includes(v.age)) errors.push('Age is required.');
  if (!GENDERS.includes(v.gender)) errors.push('Gender is required.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v.email)) errors.push('A valid email is required.');
  if (!v.phone) errors.push('Phone number is required.');
  if (v.location_type === 'philippines') {
    v.region = PH_REGIONS.includes(str(b.phRegion)) ? str(b.phRegion) : null;
    v.city = str(b.phCity, 100) || null;
    if (!v.region || !v.city) errors.push('Region and city are required.');
  } else if (v.location_type === 'international') {
    v.country = str(b.intCountry, 100) || null;
    v.city = str(b.intCity, 100) || null;
    if (!v.country || !v.city) errors.push('Country and city are required.');
  } else {
    errors.push('Location is required.');
  }
  if (!v.home_church) errors.push('Home church is required.');
  if (!v.roles.length) errors.push('Choose at least one area to serve in.');
  if (!v.availability.length) errors.push('Choose at least one day.');
  if (v.age === '14-17' && !v.guardian_consent) errors.push('Parental consent is required for volunteers under 18.');
  if (b.acceptTerms !== true) errors.push('Please accept the Code of Conduct and Data Privacy Consent.');
  if (errors.length) return reply(400, { error: errors[0], errors });

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // One sign-up per email: a second tap or a retry after a timeout doesn't create a duplicate.
    const { data: existing, error: findErr } = await supabase
      .from('volunteer_applications').select('id').eq('email', v.email).limit(1);
    if (findErr) throw new Error(findErr.message);
    if (existing && existing.length) return reply(200, { success: true, duplicate: true });

    const { error: insErr } = await supabase.from('volunteer_applications').insert([v]);
    if (insErr) throw new Error(insErr.message);

    const name = v.first_name + ' ' + v.last_name;
    const roleNames = v.roles.map(r => ROLES[r]);
    const dayNames = v.availability.map(d => DAYS[d]);

    // Telegram (non-fatal)
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN, chatId = process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: `🙋 New volunteer: ${name} (${v.age}) — ${roleNames.join(', ')}` })
        });
      }
    } catch (e) { console.error('Telegram error (non-fatal):', e.message); }

    // Confirmation email (non-fatal)
    try {
      if (process.env.BREVO_API_KEY) {
        SibApiV3Sdk.ApiClient.instance.authentications['api-key'].apiKey = process.env.BREVO_API_KEY;
        const api = new SibApiV3Sdk.TransactionalEmailsApi();
        await api.sendTransacEmail({
          to: [{ email: v.email, name }],
          sender: { name: 'PYC 2027', email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org' },
          subject: 'PYC 2027 — Thank you for volunteering!',
          htmlContent: `<!DOCTYPE html><html><body style="margin:0;background:#f5f5f7;font-family:-apple-system,Segoe UI,Arial,sans-serif;">
            <div style="max-width:560px;margin:32px auto;background:#fff;border-radius:14px;overflow:hidden;">
              <div style="background:#000;color:#f5f5f7;padding:26px 28px;">
                <div style="font-size:13px;color:#c9b897;font-weight:600;">PYC 2027 &middot; Abide</div>
                <div style="font-size:26px;font-weight:700;margin-top:4px;">Thank you for volunteering!</div>
              </div>
              <div style="padding:26px 28px;color:#1d1d1f;font-size:15px;line-height:1.6;">
                <p>Hi ${escapeHtml(v.first_name)},</p>
                <p>We received your sign-up to serve at PYC 2027 (June 2&ndash;6, 2027 &middot; SMX Convention Center Davao). Our team will contact you with your team assignment and orientation details.</p>
                <p style="margin:18px 0 6px;font-weight:600;">You signed up for</p>
                <p style="margin:0;color:#6e6e73;">${roleNames.map(escapeHtml).join('<br>')}</p>
                <p style="margin:18px 0 6px;font-weight:600;">Available</p>
                <p style="margin:0;color:#6e6e73;">${dayNames.map(escapeHtml).join('<br>')}</p>
                <p style="margin-top:22px;">Volunteers still need to register for the conference. If you haven&rsquo;t yet: <a href="https://philippineyouthforchrist.org/register-v2" style="color:#946414;">register here</a>.</p>
                <p style="margin-top:22px;">Blessings,<br><strong>The PYC Team</strong></p>
              </div>
            </div></body></html>`
        });
      }
    } catch (e) { console.error('Volunteer email error (non-fatal):', e.message); }

    return reply(200, { success: true });
  } catch (error) {
    console.error('submit-volunteer error:', error.message);
    return reply(500, { error: 'Something went wrong saving your sign-up. Please try again in a moment.' });
  }
};
