const { createClient } = require('@supabase/supabase-js');
const SibApiV3Sdk = require('sib-api-v3-sdk');

// ============================================================================
// PYC NUMBER ALLOCATION — cap-proof + collision-safe
//
// The OLD approach was:
//   select('confirmation_number').not('confirmation_number','is',null)
//   then loop in JS to find the max.
// This is broken for two reasons:
//   1. PostgREST caps results at 1000 rows by default. Once 1000+ numbers were
//      assigned, the query never saw the true maximum, so it kept computing the
//      same "next" number (e.g. always 1183) — the stuck-number symptom.
//   2. Two simultaneous approvals would both read the same max and assign the
//      same number (or one would silently fail).
//
// The new approach asks Postgres directly for the single highest number
// (order desc, limit 1) which is NOT subject to the 1000-row cap, then does a
// small retry loop to absorb any race between concurrent approvals.
// ============================================================================
async function allocatePycNumber(supabase) {
  // Pull the highest existing confirmation_number directly from Postgres.
  // Ordering by the text column works because all numbers are zero-padded to 4
  // digits (PYC-0001 .. PYC-9999), so lexical order == numeric order.
  // We still parse + Math.max defensively in case of any malformed values.
  const { data: topRows, error } = await supabase
    .from('registrations')
    .select('confirmation_number')
    .not('confirmation_number', 'is', null)
    .order('confirmation_number', { ascending: false })
    .limit(5); // pull a few in case the very top has a malformed value

  if (error) {
    console.error('[allocatePycNumber] query error:', error.message);
    throw new Error('Failed to read existing PYC numbers: ' + error.message);
  }

  let maxNum = 0;
  (topRows || []).forEach(r => {
    const p = parseInt(String(r.confirmation_number || '').replace('PYC-', ''), 10);
    if (!isNaN(p) && p > maxNum) maxNum = p;
  });
  return maxNum + 1;
}

// Claims the next available PYC number for a registration row, retrying on
// collision. Returns the assigned string (e.g. 'PYC-1183'). Writes only if the
// row doesn't already have a number. Safe to call repeatedly.
async function assignPycToRegistration(supabase, registrationId) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const candidateNum = await allocatePycNumber(supabase);
    const candidate = 'PYC-' + String(candidateNum + attempt).padStart(4, '0');
    // Only set it if still empty (avoids clobbering a number assigned by a
    // concurrent request). If another request grabbed this exact number, the
    // unique index (if present) will reject and we retry the next integer.
    const { data: updated, error: updErr } = await supabase
      .from('registrations')
      .update({ confirmation_number: candidate })
      .eq('id', registrationId)
      .is('confirmation_number', null)
      .select('confirmation_number')
      .maybeSingle();

    if (updErr) {
      // Likely a unique-constraint collision — try the next number
      console.warn('[assignPycToRegistration] attempt', attempt, 'collision/err:', updErr.message);
      continue;
    }
    if (updated && updated.confirmation_number) {
      return updated.confirmation_number;
    }
    // updated is null → the row already had a number (set by us earlier or a
    // concurrent request). Re-read and return whatever is there.
    const { data: existing } = await supabase
      .from('registrations')
      .select('confirmation_number')
      .eq('id', registrationId)
      .single();
    if (existing && existing.confirmation_number) return existing.confirmation_number;
  }
  throw new Error('Could not allocate a PYC number after multiple attempts');
}

exports.handler = async (event, context) => {
  // Add CORS headers
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
    const { registrationId, approve } = JSON.parse(event.body);

    if (!registrationId || approve === undefined) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Missing required fields' })
      };
    }

    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Get registration details
    const { data: registration, error: fetchError } = await supabase
      .from('registrations')
      .select('*')
      .eq('id', registrationId)
      .single();

    if (fetchError || !registration) {
      console.error('Fetch error:', fetchError);
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ error: 'Registration not found' })
      };
    }

    // Ensure confirmation_number exists before emailing
    if (!registration.confirmation_number) {
      try {
        registration.confirmation_number = await assignPycToRegistration(supabase, registration.id);
      } catch (e) { console.error('Conf num gen error:', e.message); }
    }

    if (approve) {
      // APPROVE RESUBMISSION
      if (registration.group_id) {
        const { error: updateError } = await supabase
          .from('registrations')
          .update({ payment_status: 'Paid' })
          .eq('group_id', registration.group_id);
        if (updateError) { console.error('Update error:', updateError); throw new Error('Failed to approve: ' + updateError.message); }
      } else {
        const { error: updateError } = await supabase
          .from('registrations')
          .update({ payment_status: 'Paid' })
          .eq('id', registrationId);
        if (updateError) { console.error('Update error:', updateError); throw new Error('Failed to approve: ' + updateError.message); }
      }

      // Send approval email
      try {
        await sendApprovalEmail(registration);
        console.log('Resubmission approval email sent for:', registration.first_name, registration.last_name);
        
        // If group, send to each member
        if (registration.group_id) {
          const { data: groupMembers } = await supabase
            .from('registrations')
            .select('*')
            .eq('group_id', registration.group_id)
            .neq('id', registrationId);
          
          if (groupMembers && groupMembers.length > 0) {
            for (const member of groupMembers) {
              try {
                if (!member.confirmation_number) {
                  // Allocate a fresh, collision-safe number per member. Each call
                  // re-reads the true max from Postgres, so concurrent approvals
                  // and the 1000-row cap are both handled correctly.
                  member.confirmation_number = await assignPycToRegistration(supabase, member.id);
                }
                await sendApprovalEmail(member);
                console.log('Group member resubmission email sent for:', member.first_name, member.last_name, member.confirmation_number);
              } catch (e) { console.error('Group member email error:', member.first_name, member.last_name, e.message); }
            }
          }
        }
      } catch (emailError) {
        console.error('Email error:', emailError);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Resubmission approved! Confirmation email sent.'
        })
      };

    } else {
      // REJECT RESUBMISSION
      if (registration.group_id) {
        const { error: updateError } = await supabase
          .from('registrations')
          .update({ payment_status: 'Rejected', payment_proof_url: null })
          .eq('group_id', registration.group_id);
        if (updateError) { console.error('Update error:', updateError); throw new Error('Failed to reject: ' + updateError.message); }
      } else {
        const { error: updateError } = await supabase
          .from('registrations')
          .update({ payment_status: 'Rejected', payment_proof_url: null })
          .eq('id', registrationId);
        if (updateError) { console.error('Update error:', updateError); throw new Error('Failed to reject: ' + updateError.message); }
      }

      // Send rejection email
      try {
        await sendRejectionEmail(registration);
      } catch (emailError) {
        console.error('Email error:', emailError);
      }

      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({
          success: true,
          message: 'Resubmission rejected. Notification email sent.'
        })
      };
    }

  } catch (error) {
    console.error('Process resubmission error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'Failed to process resubmission',
        message: error.message
      })
    };
  }
};

async function sendApprovalEmail(registration) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  function formatShirtSize(size) {
    if (!size) return 'N/A';
    const s = size.toLowerCase();
    if (s.startsWith('kids_')) return 'Kids Size ' + s.replace('kids_', '');
    return size.toUpperCase();
  }

  const mealPlanNames = { 'vegan': 'Full Meal — Vegan', 'vegetarian': 'Full Meal — Vegetarian', 'none': 'No Meal Plan', 'full': 'Full Meal Plan', 'half': 'Half Meal Plan' };
  const name = `${registration.first_name} ${registration.last_name}`;
  const mealPlan = mealPlanNames[registration.meal_plan] || registration.meal_plan || 'N/A';
  const pricingLabel = registration.meal_plan === 'none'
    ? (registration.pricing_type === 'early_bird' ? 'EARLY BIRD RATE w/o Meals' : 'REGULAR RATE w/o Meals')
    : (registration.pricing_type === 'early_bird' ? 'EARLY BIRD RATE w/ Meals' : 'REGULAR RATE w/ Meals');
  const region = registration.region || registration.country || 'N/A';
  const confNum = registration.confirmation_number || 'N/A';
  const regDate = registration.created_at ? new Date(registration.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }) : 'N/A';
  const amount = registration.total_amount ? `Php${Number(registration.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'N/A';
  const shirtSize = formatShirtSize(registration.tshirt_size);

  const receiptCard = `
    <div style="max-width:550px;margin:20px auto;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden;font-family:Arial,sans-serif;">
      <div style="background:#1a2332;padding:18px;text-align:center;">
        <h2 style="margin:0;color:#d4a556;font-size:22px;font-style:italic;font-weight:bold;">PYC 2026, Above and Beyond</h2>
      </div>
      <div style="padding:30px 35px;background:#fff;">
        <table style="width:100%;border-collapse:collapse;font-size:14px;">
          <tr><td style="padding:8px 0;font-weight:bold;width:45%;color:#333;">Name</td><td style="padding:8px 0;color:#555;">${name}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#333;">Date of Online Registration</td><td style="padding:8px 0;color:#555;">${regDate}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#333;">Registration Category</td><td style="padding:8px 0;color:#555;">${pricingLabel}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#333;">Amount Paid</td><td style="padding:8px 0;color:#555;">${amount}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#333;">Shirt Size</td><td style="padding:8px 0;color:#555;">${shirtSize}</td></tr>
          <tr><td style="padding:8px 0;font-weight:bold;color:#333;">Queue at On-site Registration</td><td style="padding:8px 0;color:#555;">${region}</td></tr>
        </table>
        <div style="margin-top:20px;padding-top:15px;border-top:1px solid #eee;">
          <p style="font-style:italic;color:#888;font-size:13px;margin:0;">This serves as your official receipt. No need to print! Just save an electronic copy to be presented during the on-site registration.</p>
        </div>
      </div>
      <div style="text-align:right;padding:10px 20px;">
        <span style="display:inline-block;border:2px solid #6b2737;border-radius:4px;padding:6px 12px;font-size:13px;color:#6b2737;">Receipt No. <strong>${confNum}</strong></span>
      </div>
    </div>`;

  const emailHtml = `<!DOCTYPE html><html><head><style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #1a2332 0%, #2a3f5f 100%); color: #d4a556; padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 28px; letter-spacing: 2px; }
    .content { padding: 30px; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 14px; }
  </style></head><body>
  <div class="container">
    <div class="header">
      <h1>PYC 2026</h1>
      <p style="margin:5px 0 0;color:rgba(212,165,86,0.7);font-size:14px;">Above and Beyond</p>
    </div>
    <div class="content">
      <p style="font-size:16px;color:#333;">Dear ${registration.first_name},</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">Greetings from PYC!</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">Great news! Your resubmitted payment proof has been reviewed and approved. Your registration for PYC 2026, "Above and Beyond" is now confirmed. Please see your official receipt below.</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">See you in Mountain View College, Bukidnon!</p>
      ${receiptCard}
      <p style="font-size:15px;color:#555;line-height:1.6;margin-top:25px;"><strong>Important:</strong> Please bring a valid ID for on-site check-in.</p>
      <p style="font-size:15px;color:#555;line-height:1.6;margin-top:25px;">Blessings,<br><strong>Registration Team</strong></p>
    </div>
    <div class="footer">
      <p>PYC 2026: Above and Beyond</p>
      <p>June 3-7, 2026 &middot; Mountain View College, Mindanao</p>
    </div>
  </div>
  </body></html>`;

  const sendSmtpEmail = {
    to: [{ email: registration.email, name: name }],
    sender: { name: 'PYC 2026', email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org' },
    subject: `PYC 2026 — Payment Resubmission Approved! (${confNum})`,
    htmlContent: emailHtml
  };

  await apiInstance.sendTransacEmail(sendSmtpEmail);
  console.log('Resubmission approval email sent to:', registration.email);
}


async function sendRejectionEmail(registration) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <style>
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background-color: #f5f5f5;
      margin: 0;
      padding: 0;
    }
    .container {
      max-width: 600px;
      margin: 40px auto;
      background: white;
      border-radius: 10px;
      overflow: hidden;
      box-shadow: 0 4px 6px rgba(0, 0, 0, 0.1);
    }
    .banner-image {
      width: 100%;
      display: block;
    }
    .header {
      background: linear-gradient(135deg, #1a2332 0%, #2a3f5f 100%);
      color: #d4a556;
      padding: 20px;
      text-align: center;
    }
    .header p {
      margin: 10px 0 0;
      color: #f5f5f5 !important;
      font-size: 16px;
    }
    .content {
      padding: 40px 30px;
    }
    .warning-badge {
      background: #f39c12;
      color: white;
      padding: 10px 20px;
      border-radius: 20px;
      display: inline-block;
      margin: 20px 0;
      font-weight: 600;
    }
    .info-box {
      background: #fff3cd;
      border-left: 4px solid #f39c12;
      padding: 20px;
      margin: 20px 0;
      border-radius: 4px;
    }
    .action-button {
      display: inline-block;
      background: #d4a556;
      color: #1a2332;
      padding: 15px 30px;
      text-decoration: none;
      border-radius: 8px;
      font-weight: 600;
      margin: 20px 0;
    }
    .footer {
      background: #f8f9fa;
      padding: 20px;
      text-align: center;
      color: #666;
      font-size: 14px;
    }
    .social-links {
      margin: 15px 0;
    }
    .social-links a {
      color: #d4a556;
      text-decoration: none;
      margin: 0 10px;
    }
  </style>
</head>
<body>
  <div class="container">
    <img src="https://philippineyouthforchrist.org/IMG_3908.jpeg" alt="PYC 2026" class="banner-image">
    <div class="header">
      <p style="color: #f5f5f5 !important;">June 3-7 • Mountain View College, Mindanao</p>
    </div>
    
    <div class="content">
      <h2>⚠️ Payment Proof Not Accepted</h2>
      
      <div class="warning-badge">Action Required</div>
      
      <p>Dear ${registration.first_name} ${registration.last_name},</p>
      
      <p>Unfortunately, we were unable to verify your resubmitted payment proof. This could be due to:</p>
      
      <div class="info-box">
        <ul style="margin: 10px 0; padding-left: 20px;">
          <li>The payment screenshot was unclear or incomplete</li>
          <li>The payment amount did not match the registration fee</li>
          <li>The payment details could not be verified</li>
        </ul>
      </div>

      <p><strong>What you need to do:</strong></p>
      <p>Please submit a new, clear screenshot of your GCash payment showing the complete transaction details.</p>

      <center>
        <a href="https://philippineyouthforchrist.org/resubmit-payment.html" class="action-button">Resubmit Payment Proof</a>
      </center>

      <p style="margin-top: 30px;"><strong>Your confirmation number:</strong> ${registration.confirmation_number || registration.id}</p>
    </div>

    <div class="footer">
      <p><strong>Philippine Youth for Christ</strong></p>
      <p style="color: #999 !important;">June 3-7 | Mountain View College, Mindanao, Philippines</p>
      <div class="social-links">
        <a href="https://www.facebook.com/share/1D9PJw6wkq/?mibextid=wwXIfr">Facebook</a> |
        <a href="https://www.instagram.com/philippineyouthforchrist?igsh=c2Q0MjAwbWh1cXZ2">Instagram</a>
      </div>
      <p style="font-size: 12px; color: #999 !important; margin-top: 20px;">
        For questions or concerns, contact us through social media
      </p>
    </div>
  </div>
</body>
</html>
  `;

  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  
  sendSmtpEmail.sender = {
    name: 'Philippine Youth for Christ',
    email: 'noreply@philippineyouthforchrist.org'
  };
  
  sendSmtpEmail.to = [{
    email: registration.email,
    name: `${registration.first_name} ${registration.last_name}`
  }];
  
  sendSmtpEmail.subject = `Payment Resubmission Required - PYC 2026 (${registration.confirmation_number || registration.id})`;
  sendSmtpEmail.htmlContent = emailHtml;

  await apiInstance.sendTransacEmail(sendSmtpEmail);
}
