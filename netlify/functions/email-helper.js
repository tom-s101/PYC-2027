const SibApiV3Sdk = require('sib-api-v3-sdk');

function formatShirtSize(size) {
  if (!size) return 'N/A';
  const s = size.toLowerCase();
  if (s.startsWith('kids_')) return 'Kids Size ' + s.replace('kids_', '');
  return size.toUpperCase();
}
const { createClient } = require('@supabase/supabase-js');

async function sendConfirmationEmail(registrationData, paymentMethod) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const mealPlanNames = { 'vegan': 'Full Meal — Vegan', 'vegetarian': 'Full Meal — Vegetarian', 'none': 'No Meal Plan', 'full': 'Full Meal Plan', 'half': 'Half Meal Plan' };
  const mealPlanName = mealPlanNames[registrationData.meal_plan] || registrationData.meal_plan || 'N/A';

  const isStripe = paymentMethod === 'card' || paymentMethod === 'Stripe';
  const isGroup = registrationData.registration_type === 'group';

  // If group, fetch all group members
  let groupMembers = [];
  let groupTotalAmount = registrationData.total_amount || 0;
  if (isGroup && registrationData.group_id) {
    try {
      const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
      const { data: members, error: membersError } = await supabase
        .from('registrations')
        .select('*')
        .eq('group_id', registrationData.group_id)
        .order('is_primary', { ascending: false });
      if (!membersError && members && members.length > 0) {
        groupMembers = members;
        const EARLY_BIRD_DEADLINE = new Date('2026-03-31T23:59:59+08:00');
        const isEB = new Date(registrationData.created_at || Date.now()) <= EARLY_BIRD_DEADLINE;
        const EP = isEB ? { vegan: 2100, withMeal: 1750, noMeal: 750 } : { vegan: 2200, withMeal: 1850, noMeal: 850 };
        const MP = { 'vegan': EP.vegan, 'vegetarian': EP.withMeal, 'none': EP.noMeal };
        groupTotalAmount = members.reduce((sum, m) => {
          const amt = m.total_amount || MP[m.meal_plan] || 0;
          return sum + amt;
        }, 0);
      }
    } catch (e) {
      console.error('Error fetching group members for email:', e);
    }
  }

  const paymentStatusMessage = isStripe
    ? '<h2 style="color:#1a2332;">&#9989; Payment Confirmed!</h2><p><strong>Your payment has been successfully processed.</strong></p>'
    : '<h2 style="color:#1a2332;">&#128203; Payment Under Review</h2><p><strong>Your payment proof has been received and is under review.</strong></p><p>You will receive another email once your payment is verified.</p>';

  // Build group members HTML
  let groupMembersHtml = '';
  if (isGroup && groupMembers.length > 0) {
    // Pricing for fallback calculation
    const EARLY_BIRD_DL = new Date('2026-03-31T23:59:59+08:00');
    const isEBird = new Date(registrationData.created_at || Date.now()) <= EARLY_BIRD_DL;
    const emailPrices = isEBird ? { vegan: 2100, withMeal: 1750, noMeal: 750 } : { vegan: 2200, withMeal: 1850, noMeal: 850 };
    const emailMealPrices = { 'vegan': emailPrices.vegan, 'vegetarian': emailPrices.withMeal, 'none': emailPrices.noMeal };
    const getMemberAmt = (m) => m.total_amount || emailMealPrices[m.meal_plan] || 0;

    groupMembersHtml = `
      <h2 style="color:#1a2332;margin-top:30px;">&#128101; Group Members (${groupMembers.length} total)</h2>
      <div style="background:#f8f9fa;border-left:4px solid #d4a556;padding:20px;margin:20px 0;border-radius:4px;">
        ${groupMembers.map((m, i) => `
          <div style="padding:10px 0;${i < groupMembers.length - 1 ? 'border-bottom:1px solid #e0e0e0;' : ''}">
            <div style="display:flex;justify-content:space-between;">
              <span style="font-weight:600;color:#1a2332;">${m.first_name} ${m.last_name} ${m.is_primary ? '(Primary)' : ''}</span>
              <span style="color:#555;">${mealPlanNames[m.meal_plan] || m.meal_plan}</span>
            </div>
            <div style="display:flex;justify-content:space-between;margin-top:5px;">
              <span style="color:#777;font-size:14px;">T-Shirt: ${formatShirtSize(m.tshirt_size)} | Age: ${m.age || 'N/A'}</span>
              <span style="color:#555;">\u20B1${getMemberAmt(m).toFixed(2)}</span>
            </div>
          </div>
        `).join('')}
      </div>
      <div style="background:#d4a556;color:white;padding:15px 20px;margin:20px 0;border-radius:8px;display:flex;justify-content:space-between;font-size:18px;font-weight:bold;">
        <span>Group Total:</span>
        <span>\u20B1${groupTotalAmount.toFixed(2)}</span>
      </div>`;
  }

  const emailHtml = `<!DOCTYPE html><html><head><style>
    body { font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; background-color: #f5f5f5; margin: 0; padding: 0; }
    .container { max-width: 600px; margin: 40px auto; background: white; border-radius: 10px; overflow: hidden; box-shadow: 0 4px 6px rgba(0,0,0,0.1); }
    .header { background: linear-gradient(135deg, #1a2332 0%, #2a3f5f 100%); color: #d4a556; padding: 20px; text-align: center; }
    .header h1 { margin: 0; font-size: 32px; letter-spacing: 2px; }
    .content { padding: 40px 30px; }
    .info-box { background: #f8f9fa; border-left: 4px solid #d4a556; padding: 20px; margin: 20px 0; border-radius: 4px; }
    .info-row { display: flex; justify-content: space-between; padding: 10px 0; border-bottom: 1px solid #e0e0e0; }
    .info-row:last-child { border-bottom: none; }
    .info-label { font-weight: 600; color: #1a2332; }
    .info-value { color: #555; }
    .footer { background: #f8f9fa; padding: 20px; text-align: center; color: #666; font-size: 14px; }
    .social-links { margin: 15px 0; }
    .social-links a { color: #d4a556; text-decoration: none; margin: 0 10px; }
  </style></head><body>
  <div class="container">
    <img src="${process.env.URL || 'https://philippineyouthforchrist.org'}/IMG_3908.jpeg" alt="PYC 2026" style="width:100%;display:block;">
    <div class="header"><p style="color:#f5f5f5;">June 3-7 &bull; Mountain View College, Mindanao</p></div>
    <div class="content">
      ${paymentStatusMessage}
      <p>Dear ${registrationData.first_name} ${registrationData.last_name},</p>
      <p>Thank you for registering${isGroup ? ' your group' : ''} for Philippine Youth for Christ 2026!</p>
      
      <div class="info-box">
        <div class="info-row"><span class="info-label">Registration Number: </span><span class="info-value">${registrationData.confirmation_number || "Pending"}</span></div>
        <div class="info-row"><span class="info-label">Name: </span><span class="info-value">${registrationData.first_name} ${registrationData.last_name}</span></div>
        <div class="info-row"><span class="info-label">Email: </span><span class="info-value">${registrationData.email}</span></div>
        <div class="info-row"><span class="info-label">Registration Type: </span><span class="info-value">${isGroup ? 'Family/Group' : 'Individual'}</span></div>
        ${!isGroup ? `
        <div class="info-row"><span class="info-label">T-Shirt Size: </span><span class="info-value">${formatShirtSize(registrationData.tshirt_size)}</span></div>
        <div class="info-row"><span class="info-label">Meal Plan: </span><span class="info-value">${mealPlanName}</span></div>
        ` : ''}
        <div class="info-row"><span class="info-label">Payment Method: </span><span class="info-value">${paymentMethod}</span></div>

      </div>

      ${groupMembersHtml}

      ${!isGroup ? `
      <div style="background:#d4a556;color:white;padding:15px 20px;margin:20px 0;border-radius:8px;display:flex;justify-content:space-between;font-size:18px;font-weight:bold;">
        <span>Total Amount:</span>
        <span>\u20B1${(registrationData.total_amount || 0).toFixed(2)}</span>
      </div>` : ''}

      <p style="margin-top:30px;color:#666;font-size:14px;">
        <strong>Important:</strong> Please keep this email for your records. Your registration number is: <strong>${registrationData.confirmation_number || "Pending"}</strong>
      </p>
    </div>
    <div class="footer">
      <p><strong>Philippine Youth for Christ</strong></p>
      <p style="color:#999;">June 3-7 | Mountain View College, Mindanao, Philippines</p>
      <div class="social-links">
        <a href="https://www.facebook.com/share/1D9PJw6wkq/?mibextid=wwXIfr">Facebook</a> |
        <a href="https://www.instagram.com/philippineyouthforchrist?igsh=c2Q0MjAwbWh1cXZ2">Instagram</a>
      </div>
      <p style="font-size:12px;color:#999;margin-top:20px;">Questions? Contact us at info@philippineyouthforchrist.org</p>
    </div>
  </div></body></html>`;

  const sendSmtpEmail = new SibApiV3Sdk.SendSmtpEmail();
  sendSmtpEmail.sender = {
    name: 'Philippine Youth for Christ',
    email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org'
  };
  sendSmtpEmail.to = [{ email: registrationData.email, name: `${registrationData.first_name} ${registrationData.last_name}` }];
  
  const subject = isStripe
    ? `Payment Confirmed - PYC 2026 ${isGroup ? '(Group)' : ''} (${registrationData.confirmation_number || 'PYC'})`
    : `Payment Received - Under Review - PYC 2026 ${isGroup ? '(Group)' : ''} (${registrationData.confirmation_number || 'PYC'})`;
  
  sendSmtpEmail.subject = subject;
  sendSmtpEmail.htmlContent = emailHtml;
  await apiInstance.sendTransacEmail(sendSmtpEmail);
}



async function sendApprovalReceiptEmail(registrationData, hasMinorInGroup) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const mealPlanNames = { 'vegan': 'Full Meal — Vegan', 'vegetarian': 'Full Meal — Vegetarian', 'none': 'No Meal Plan', 'full': 'Full Meal Plan', 'half': 'Half Meal Plan' };
  const name = `${registrationData.first_name} ${registrationData.last_name}`;
  const mealPlan = mealPlanNames[registrationData.meal_plan] || registrationData.meal_plan || 'N/A';
  const pricingLabel = registrationData.meal_plan === 'none'
    ? (registrationData.pricing_type === 'early_bird' ? 'EARLY BIRD RATE w/o Meals' : 'REGULAR RATE w/o Meals')
    : (registrationData.pricing_type === 'early_bird' ? 'EARLY BIRD RATE w/ Meals' : 'REGULAR RATE w/ Meals');
  const region = registrationData.region || registrationData.country || 'N/A';
  const confNum = registrationData.confirmation_number || 'N/A';
  const minorAges = ['0-8', '9-13', '13-17', '14-17'];
  const isMinor = minorAges.includes(registrationData.age);
  const showWaiverReminder = isMinor || hasMinorInGroup;
  const regDate = registrationData.created_at ? new Date(registrationData.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }) : 'N/A';
  const amount = registrationData.total_amount ? `Php${Number(registrationData.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'N/A';
  const shirtSize = formatShirtSize(registrationData.tshirt_size);

  const receiptCard = `
    <div style="max-width:550px;margin:20px auto;background:#fff;border:1px solid #ddd;border-radius:4px;overflow:hidden;font-family:Arial,sans-serif;">
      <div style="background:#1a2332;padding:18px;text-align:center;">
        <h2 style="margin:0;color:#d4a556;font-size:22px;font-style:italic;font-weight:bold;">PYC 2026, Above and Beyond</h2>
      </div>
      <div style="padding:30px 35px;background:#fff url('') no-repeat center;background-size:contain;">
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
      <p style="font-size:16px;color:#333;">Dear ${registrationData.first_name},</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">Greetings from PYC!</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">We would like to confirm your registration for PYC 2026, "Above and Beyond". Please see attached receipt to be presented during the on-site registration.</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">See you in Mountain View College, Bukidnon!</p>
      ${receiptCard}
      <p style="font-size:15px;color:#555;line-height:1.6;margin-top:25px;"><strong>Important:</strong> Please bring a valid ID for on-site check-in.</p>
      ${showWaiverReminder ? '<div style="margin-top:20px;padding:18px;background:#fff3cd;border-left:4px solid #f39c12;border-radius:4px;"><p style="font-size:15px;color:#333;margin:0 0 8px;"><strong>Minor Waiver Required</strong></p><p style="font-size:14px;color:#555;line-height:1.6;margin:0;">Since there is a registrant under 18 in this registration, a signed and printed <strong>Minor Waiver Form</strong> must be brought to the conference and submitted to the organizers upon check-in. Please download the waiver below if you need another copy:</p><p style="margin:12px 0 0;"><a href="https://philippineyouthforchrist.org/PYC_2026_Minor_Waiver.pdf" style="color:#d4a556;font-weight:600;text-decoration:underline;">Download Minor Waiver Form</a></p></div>' : ''}
      <p style="font-size:15px;color:#555;line-height:1.6;margin-top:25px;">Blessings,<br><strong>Registration Team</strong></p>
    </div>
    <div class="footer">
      <p>PYC 2026: Above and Beyond</p>
      <p>June 3-7, 2026 &middot; Mountain View College, Mindanao</p>
    </div>
  </div>
  </body></html>`;

  const sendSmtpEmail = {
    to: [{ email: registrationData.email, name: name }],
    sender: { name: 'PYC 2026', email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org' },
    subject: `PYC 2026 — Payment Confirmed! (${confNum})`,
    htmlContent: emailHtml
  };

  await apiInstance.sendTransacEmail(sendSmtpEmail);
  console.log('Approval receipt email sent to:', registrationData.email);
}



async function sendRejectionEmail(registrationData) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const name = `${registrationData.first_name} ${registrationData.last_name}`;
  const confNum = registrationData.confirmation_number || 'PYC';

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
      <h2 style="color:#e74c3c;">&#10060; Payment Not Verified</h2>
      <p style="font-size:16px;color:#333;">Dear ${registrationData.first_name},</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">Unfortunately, we were unable to verify your payment for PYC 2026. This could be due to one of the following reasons:</p>
      <ul style="color:#555;font-size:15px;line-height:1.8;">
        <li>The payment proof image was unclear or unreadable</li>
        <li>The amount did not match the registration total</li>
        <li>The transaction could not be found in the account</li>
      </ul>
      <p style="font-size:15px;color:#555;line-height:1.6;"><strong>What to do next:</strong> Please resubmit your payment proof using the link below. Make sure the screenshot clearly shows the transaction amount, date, and reference number.</p>
      <div style="text-align:center;margin:25px 0;">
        <a href="https://philippineyouthforchrist.org/resubmit-payment" style="display:inline-block;background:#d4a556;color:#1a2332;padding:14px 30px;border-radius:8px;text-decoration:none;font-weight:700;font-size:15px;">Resubmit Payment Proof</a>
      </div>
      <p style="font-size:14px;color:#888;">Your registration number: <strong>${confNum}</strong></p>
    </div>
    <div class="footer">
      <p><strong>Philippine Youth for Christ</strong></p>
      <p style="color:#999;">June 3-7 | Mountain View College, Mindanao, Philippines</p>
    </div>
  </div></body></html>`;

  const sendSmtpEmail = {
    to: [{ email: registrationData.email, name: name }],
    sender: { name: 'PYC 2026', email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org' },
    subject: `PYC 2026 — Payment Not Verified (${confNum})`,
    htmlContent: emailHtml
  };

  await apiInstance.sendTransacEmail(sendSmtpEmail);
  console.log('Rejection email sent to:', registrationData.email);
}

// PYC CORRECTION EMAIL — apology + corrected confirmation number + full receipt.
// Used by the one-time recovery tool for people whose confirmation number failed
// to assign due to the old broken allocator. Mirrors the approval receipt design
// but leads with an apology banner and the corrected number.
async function sendPycCorrectionEmail(registrationData, hasMinorInGroup) {
  const defaultClient = SibApiV3Sdk.ApiClient.instance;
  const apiKey = defaultClient.authentications['api-key'];
  apiKey.apiKey = process.env.BREVO_API_KEY;
  const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();

  const mealPlanNames = { 'vegan': 'Full Meal — Vegan', 'vegetarian': 'Full Meal — Vegetarian', 'none': 'No Meal Plan', 'full': 'Full Meal Plan', 'half': 'Half Meal Plan' };
  const name = `${registrationData.first_name} ${registrationData.last_name}`;
  const pricingLabel = registrationData.meal_plan === 'none'
    ? (registrationData.pricing_type === 'early_bird' ? 'EARLY BIRD RATE w/o Meals' : 'REGULAR RATE w/o Meals')
    : (registrationData.pricing_type === 'early_bird' ? 'EARLY BIRD RATE w/ Meals' : 'REGULAR RATE w/ Meals');
  const region = registrationData.region || registrationData.country || 'N/A';
  const confNum = registrationData.confirmation_number || 'N/A';
  const minorAges = ['0-8', '9-13', '13-17', '14-17'];
  const isMinor = minorAges.includes(registrationData.age);
  const showWaiverReminder = isMinor || hasMinorInGroup;
  const regDate = registrationData.created_at ? new Date(registrationData.created_at).toLocaleDateString('en-US', { year: 'numeric', month: 'numeric', day: 'numeric' }) : 'N/A';
  const amount = registrationData.total_amount ? `Php${Number(registrationData.total_amount).toLocaleString('en-US', { minimumFractionDigits: 2 })}` : 'N/A';
  const shirtSize = formatShirtSize(registrationData.tshirt_size);

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
      <p style="font-size:16px;color:#333;">Dear ${registrationData.first_name},</p>
      <div style="margin:0 0 20px;padding:18px;background:#fff3cd;border-left:4px solid #f39c12;border-radius:4px;">
        <p style="font-size:15px;color:#333;margin:0 0 8px;"><strong>Update to Your Confirmation Number</strong></p>
        <p style="font-size:14px;color:#555;line-height:1.6;margin:0;">We're sorry &mdash; due to a technical issue, your PYC confirmation number was not assigned correctly. We've now fixed this. Your correct confirmation number is <strong style="color:#1a2332;">${confNum}</strong>. Please disregard any number you may have received in a previous email and use this one going forward.</p>
      </div>
      <p style="font-size:15px;color:#555;line-height:1.6;">Your registration for PYC 2026, "Above and Beyond" is confirmed. Please see the receipt below to be presented during on-site registration.</p>
      <p style="font-size:15px;color:#555;line-height:1.6;">See you in Mountain View College, Bukidnon!</p>
      ${receiptCard}
      <p style="font-size:15px;color:#555;line-height:1.6;margin-top:25px;"><strong>Important:</strong> Please bring a valid ID for on-site check-in.</p>
      ${showWaiverReminder ? '<div style="margin-top:20px;padding:18px;background:#fff3cd;border-left:4px solid #f39c12;border-radius:4px;"><p style="font-size:15px;color:#333;margin:0 0 8px;"><strong>Minor Waiver Required</strong></p><p style="font-size:14px;color:#555;line-height:1.6;margin:0;">Since there is a registrant under 18 in this registration, a signed and printed <strong>Minor Waiver Form</strong> must be brought to the conference and submitted to the organizers upon check-in. Please download the waiver below if you need another copy:</p><p style="margin:12px 0 0;"><a href="https://philippineyouthforchrist.org/PYC_2026_Minor_Waiver.pdf" style="color:#d4a556;font-weight:600;text-decoration:underline;">Download Minor Waiver Form</a></p></div>' : ''}
      <p style="font-size:15px;color:#555;line-height:1.6;margin-top:25px;">Thank you for your patience, and our apologies for any confusion.</p>
      <p style="font-size:15px;color:#555;line-height:1.6;margin-top:10px;">Blessings,<br><strong>Registration Team</strong></p>
    </div>
    <div class="footer">
      <p>PYC 2026: Above and Beyond</p>
      <p>June 3-7, 2026 &middot; Mountain View College, Mindanao</p>
    </div>
  </div>
  </body></html>`;

  const sendSmtpEmail = {
    to: [{ email: registrationData.email, name: name }],
    sender: { name: 'PYC 2026', email: process.env.BREVO_FROM_EMAIL || 'noreply@philippineyouthforchrist.org' },
    subject: `PYC 2026 — Your Corrected Confirmation Number (${confNum})`,
    htmlContent: emailHtml
  };

  await apiInstance.sendTransacEmail(sendSmtpEmail);
  console.log('PYC correction email sent to:', registrationData.email, confNum);
}

module.exports = { sendConfirmationEmail, sendApprovalReceiptEmail, sendRejectionEmail, sendPycCorrectionEmail };
