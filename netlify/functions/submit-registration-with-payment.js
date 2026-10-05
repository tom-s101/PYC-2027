const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const { sendConfirmationEmail } = require('./email-helper');

// ============================================================================
// PYC 2027 register-v2 — merged single-commit backend.
//
// Replaces the two-step live flow (submit-registration.js creates a "Pending"
// row, upload-payment-proof.js later adds the image) with ONE request sent at
// proof-upload time:  { shared info, registrants[], payment, image }.
//
// Nothing exists in the DB before this call, so people who abandon the form
// never create dead/duplicate rows. Used ONLY by public/register-v2.html; the
// live functions stay untouched until v2 is proven.
//
// Order of work:
//   1. Validate everything (prices are recomputed here — client total is ignored)
//   2. Duplicate-submit check (same email + reference already saved -> return it)
//   3. Upload the (browser-compressed) image to the payment-proofs bucket
//   4. Insert ALL rows in a single multi-row insert (all-or-nothing)
//   5. Assign PYC numbers (cap-proof allocator, same as approve-payment.js)
//   6. Confirmation email + Telegram (non-fatal)
// ============================================================================

// Early bird ends 11:59 PM Philippine Time (UTC+8). Keep in sync with register-v2.html.
const EARLY_BIRD_DEADLINE = Date.parse('2027-04-15T23:59:59+08:00');
// Someone who saw early-bird prices just before the deadline may submit proof a
// little after it; honour the early price for this long after the deadline.
const EARLY_BIRD_GRACE_MS = 24 * 60 * 60 * 1000;
const PRICE_TIERS = {
  early_bird: { vegan: 2100, vegetarian: 1750, none: 750 },
  regular:    { vegan: 2200, vegetarian: 1850, none: 850 }
};
// Set to a Date.UTC(...) value to close public registration; null = open.
const REGISTRATION_CLOSE_AT = null;

const AGES = ['0-8', '9-13', '14-17', '18-25', '26-35', '36+'];
const MINOR_AGES = ['0-8', '9-13', '14-17'];
const GENDERS = ['Male', 'Female'];
const SHIRTS = ['xs', 's', 'm', 'l', 'xl', '2xl', '3xl', '4xl', '5xl'];
const MEALS = ['vegan', 'vegetarian', 'none'];
const PYC_COUNTS = ['1st', '2nd', '3rd', '4th', '5th', '6th', '7th+'];
const PH_REGIONS = ['Luzon', 'Visayas', 'Mindanao'];
const GCASH_ACCOUNTS = ['A', 'B', 'C', 'D']; // 'E' disabled, same as payment.html
const BANK_ACCOUNTS = ['bank_bdo', 'bank_bpi'];
const MAX_REGISTRANTS = 20;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

const headers = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json'
};

function reply(statusCode, body) {
  return { statusCode, headers, body: JSON.stringify(body) };
}

function str(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max || 200) : '';
}

// Identify the image by its first bytes (the MIME type sent by a browser can lie).
function sniffImage(buf) {
  if (buf.length > 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.length > 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}

// ---- PYC number allocation (copied from approve-payment.js: functions bundle
// independently, so no shared module). Reads the max directly from Postgres
// (not subject to the 1000-row cap) and retries on collision.
async function allocateNextPycNumber(supabase) {
  const { data: topRows, error } = await supabase
    .from('registrations')
    .select('confirmation_number')
    .not('confirmation_number', 'is', null)
    .order('confirmation_number', { ascending: false })
    .limit(5);
  if (error) throw new Error('Failed to read existing PYC numbers: ' + error.message);
  let maxNum = 0;
  (topRows || []).forEach(r => {
    const p = parseInt(String(r.confirmation_number || '').replace('PYC-', ''), 10);
    if (!isNaN(p) && p > maxNum) maxNum = p;
  });
  return maxNum + 1;
}

async function assignPycToRegistration(supabase, registrationId) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const base = await allocateNextPycNumber(supabase);
    const candidate = 'PYC-' + String(base + attempt).padStart(4, '0');
    const { data: updated, error: updErr } = await supabase
      .from('registrations')
      .update({ confirmation_number: candidate })
      .eq('id', registrationId)
      .is('confirmation_number', null)
      .select('confirmation_number')
      .maybeSingle();
    if (updErr) continue; // likely a unique collision — try the next number
    if (updated && updated.confirmation_number) return updated.confirmation_number;
    const { data: existing } = await supabase
      .from('registrations')
      .select('confirmation_number')
      .eq('id', registrationId)
      .single();
    if (existing && existing.confirmation_number) return existing.confirmation_number;
  }
  throw new Error('Could not allocate a PYC number after multiple attempts');
}

// ---- Validation. Returns { errors: [...], clean: {...} }.
function validate(body) {
  const errors = [];
  const shared = body.shared || {};
  const payment = body.payment || {};
  const list = Array.isArray(body.registrants) ? body.registrants : [];

  const s = {
    email: str(shared.email, 254).toLowerCase(),
    phone: str(shared.phone, 40),
    locationType: str(shared.locationType, 20),
    phRegion: str(shared.phRegion, 20),
    phCity: str(shared.phCity, 100),
    intCountry: str(shared.intCountry, 100),
    intCity: str(shared.intCity, 100),
    referralSource: str(shared.referralSource, 50),
    volunteer: shared.volunteer === 'yes' ? 'Yes' : 'No',
    acceptTerms: shared.acceptTerms === true,
    minorWaiverAccept: shared.minorWaiverAccept === 'Yes' ? 'Yes' : null
  };

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s.email)) errors.push('A valid email is required.');
  if (!s.phone) errors.push('Phone number is required.');
  if (s.locationType === 'philippines') {
    if (!PH_REGIONS.includes(s.phRegion)) errors.push('Region is required.');
    if (!s.phCity) errors.push('City is required.');
  } else if (s.locationType === 'international') {
    if (!s.intCountry) errors.push('Country is required.');
    if (!s.intCity) errors.push('City is required.');
  } else {
    errors.push('Location is required.');
  }
  if (!s.referralSource) errors.push('Please tell us how you heard about PYC.');
  if (!s.acceptTerms) errors.push('The terms must be accepted.');

  if (list.length < 1) errors.push('At least one registrant is required.');
  if (list.length > MAX_REGISTRANTS) errors.push('A group can have at most ' + MAX_REGISTRANTS + ' registrants.');

  const people = list.slice(0, MAX_REGISTRANTS).map((r, i) => {
    const p = {
      firstName: str(r.firstName, 100),
      lastName: str(r.lastName, 100),
      age: str(r.age, 10),
      gender: str(r.gender, 10),
      shirtSize: str(r.shirtSize, 10).toLowerCase(),
      mealPlan: str(r.mealPlan, 20),
      pycCount: str(r.pycCount, 10)
    };
    const who = i === 0 ? 'Registrant 1' : 'Registrant ' + (i + 1);
    if (!p.firstName || !p.lastName) errors.push(who + ': name is required.');
    if (!AGES.includes(p.age)) errors.push(who + ': age is required.');
    if (!GENDERS.includes(p.gender)) errors.push(who + ': gender is required.');
    if (!SHIRTS.includes(p.shirtSize)) errors.push(who + ': t-shirt size is required.');
    if (!MEALS.includes(p.mealPlan)) errors.push(who + ': meal plan is required.');
    if (!PYC_COUNTS.includes(p.pycCount)) errors.push(who + ': PYC count is required.');
    return p;
  });

  if (people.some(p => MINOR_AGES.includes(p.age)) && s.minorWaiverAccept !== 'Yes') {
    errors.push('Parental consent is required for registrants under 18.');
  }

  const pay = {
    method: payment.method === 'Bank Transfer' ? 'Bank Transfer' : (payment.method === 'GCash' ? 'GCash' : ''),
    account: str(payment.account, 20),
    reference: str(payment.reference, 100),
    pricingType: payment.pricingType === 'early_bird' ? 'early_bird' : 'regular'
  };
  if (!pay.method) errors.push('Payment method is required.');
  if (pay.method === 'GCash' && !GCASH_ACCOUNTS.includes(pay.account)) errors.push('Invalid GCash account.');
  if (pay.method === 'Bank Transfer' && !BANK_ACCOUNTS.includes(pay.account)) errors.push('Invalid bank account.');
  if (!pay.reference) errors.push('Payment reference number is required.');

  return { errors, shared: s, people, pay };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Method not allowed' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return reply(400, { error: 'Invalid request.' }); }

  const now = Date.now();
  if (REGISTRATION_CLOSE_AT && now >= REGISTRATION_CLOSE_AT) {
    return reply(403, { error: 'Registration is closed. Please contact the PYC team.', registrationClosed: true });
  }

  const { errors, shared, people, pay } = validate(body);
  if (errors.length) return reply(400, { error: errors[0], errors });

  // ---- Image
  const rawB64 = typeof body.imageBase64 === 'string' ? body.imageBase64.replace(/^data:[^;]+;base64,/, '') : '';
  if (!rawB64) return reply(400, { error: 'Please attach your payment screenshot.' });
  const imageBuf = Buffer.from(rawB64, 'base64');
  if (imageBuf.length > MAX_IMAGE_BYTES) return reply(413, { error: 'Image is too large. Please choose a smaller screenshot.' });
  const img = sniffImage(imageBuf);
  if (!img) return reply(400, { error: 'Please upload a JPG, PNG or WebP screenshot.' });

  // ---- Pricing (server is authoritative)
  const early = now <= EARLY_BIRD_DEADLINE ||
    (pay.pricingType === 'early_bird' && now <= EARLY_BIRD_DEADLINE + EARLY_BIRD_GRACE_MS);
  const pricingType = early ? 'early_bird' : 'regular';
  const prices = PRICE_TIERS[pricingType];

  try {
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // ---- Duplicate submit (double tap, or a retry after a timeout that actually saved)
    const { data: existing, error: dupErr } = await supabase
      .from('registrations')
      .select('id, first_name, last_name, confirmation_number, is_primary')
      .eq('email', shared.email)
      .eq('transaction_reference', pay.reference)
      .order('is_primary', { ascending: false });
    if (dupErr) throw new Error(dupErr.message);
    if (existing && existing.length) {
      return reply(200, {
        success: true,
        duplicate: true,
        registrants: existing.map(r => ({ name: r.first_name + ' ' + r.last_name, confirmationNumber: r.confirmation_number || '' }))
      });
    }

    // ---- Upload image
    const submissionId = crypto.randomUUID();
    const storagePath = `payment-proofs/v2-${submissionId}.${img.ext}`;
    const { error: uploadError } = await supabase.storage
      .from('payment-proofs')
      .upload(storagePath, imageBuf, { contentType: img.mime, upsert: false });
    if (uploadError) throw new Error('Failed to upload the screenshot: ' + uploadError.message);
    const { data: urlData } = supabase.storage.from('payment-proofs').getPublicUrl(storagePath);

    // ---- Build all rows, insert in ONE statement (all-or-nothing)
    const isGroup = people.length > 1;
    const groupId = isGroup ? crypto.randomUUID() : null;
    const uploadedAt = new Date(now).toISOString();
    const location = shared.locationType === 'philippines'
      ? { region: shared.phRegion, city: shared.phCity, country: null }
      : { region: null, city: shared.intCity, country: shared.intCountry };

    const rows = people.map((p, i) => ({
      first_name: p.firstName,
      last_name: p.lastName,
      email: shared.email,
      phone: shared.phone,
      gender: p.gender,
      age: p.age,
      pyc_count: p.pycCount,
      location_type: shared.locationType,
      region: location.region,
      city: location.city,
      country: location.country,
      tshirt_size: p.shirtSize,
      meal_plan: p.mealPlan,
      volunteer: i === 0 ? shared.volunteer : 'No',
      volunteer_role: null,
      referral_source: shared.referralSource,
      other_source: null,
      minor_waiver_accept: shared.minorWaiverAccept,
      registration_fee: 0,
      meal_fee: 0,
      total_amount: prices[p.mealPlan],
      pricing_type: pricingType,
      payment_status: 'Pending Review',
      payment_proof_url: urlData.publicUrl,
      payment_proof_uploaded_at: uploadedAt,
      payment_method: pay.method,
      payment_account: pay.account,
      transaction_reference: pay.reference,
      registration_type: isGroup ? 'group' : 'individual',
      group_id: groupId,
      is_primary: i === 0
    }));

    const { data: inserted, error: insertError } = await supabase
      .from('registrations')
      .insert(rows)
      .select();
    if (insertError) throw new Error('Failed to save registration: ' + insertError.message);

    // Primary first, others in entered order (stable sort), for numbering and the response.
    const ordered = inserted.slice().sort((a, b) => (b.is_primary ? 1 : 0) - (a.is_primary ? 1 : 0));

    // ---- PYC numbers (each person gets their own, primary first)
    for (const rec of ordered) {
      try {
        rec.confirmation_number = await assignPycToRegistration(supabase, rec.id);
      } catch (e) {
        console.error('PYC assign error for row', rec.id, ':', e.message);
      }
    }

    const primary = ordered[0];
    const groupTotal = ordered.reduce((sum, r) => sum + (r.total_amount || 0), 0);

    // ---- Confirmation email (non-fatal)
    try {
      if (isGroup) {
        primary._groupMembers = ordered;
        primary._groupTotal = groupTotal;
      }
      await sendConfirmationEmail(primary, pay.method);
    } catch (e) {
      console.error('Email error (non-fatal):', e.message);
    }

    // ---- Telegram (non-fatal)
    try {
      const botToken = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      if (botToken && chatId) {
        const nums = ordered.map(r => r.confirmation_number).filter(Boolean);
        const name = primary.first_name + ' ' + primary.last_name;
        const msg = isGroup
          ? `💳 ${nums[0] || '?'}–${nums[nums.length - 1] || '?'} Group ${name} (${ordered.length} members) submitted ${pay.method} payment proof [v2]`
          : `💳 ${nums[0] || '?'} ${name} submitted ${pay.method} payment proof [v2]`;
        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, text: msg })
        });
      }
    } catch (e) {
      console.error('Telegram error (non-fatal):', e.message);
    }

    return reply(200, {
      success: true,
      pricingType,
      totalAmount: groupTotal,
      registrants: ordered.map(r => ({ name: r.first_name + ' ' + r.last_name, confirmationNumber: r.confirmation_number || '' }))
    });
  } catch (error) {
    console.error('submit-registration-with-payment error:', error.message);
    return reply(500, { error: 'Something went wrong saving your registration. Please try again in a moment.' });
  }
};
