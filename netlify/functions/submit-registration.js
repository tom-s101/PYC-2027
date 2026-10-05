const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
function uuidv4() { return crypto.randomUUID(); }

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    const data = JSON.parse(event.body);

    // ===== REGISTRATION CUTOFF CHECK =====
    // Registration closes at the end of May 20, 2026 Philippine Time (11:59 PM PHT, UTC+8).
    // After this moment, only admin-bypass submissions are accepted. The check
    // uses the server clock (Date.now()), so changing the device clock does
    // nothing — the gate is fully server-side.
    const REGISTRATION_CLOSE_AT = Date.UTC(2026, 4, 20, 15, 59, 59); // May 20 15:59 UTC = May 20 23:59 PHT
    const nowMs = Date.now();
    if (nowMs >= REGISTRATION_CLOSE_AT) {
      const providedToken = (data.adminBypassToken || '').toString();
      const expectedToken = process.env.ADMIN_REG_BYPASS_TOKEN || '';
      const bypassOk = expectedToken.length > 0 && providedToken === expectedToken;
      if (!bypassOk) {
        return {
          statusCode: 403,
          body: JSON.stringify({
            error: 'Registration is closed. Public registration ended on May 20, 2026 (Philippine Time). Please contact the PYC team if you need to register.',
            registrationClosed: true
          })
        };
      }
      console.log('Admin bypass used for post-close registration:', data.firstName, data.lastName);
    }

    // Log incoming group data for debugging
    if (data.registrationType === 'group') {
      console.log('===== INCOMING GROUP REGISTRATION =====');
      console.log('Primary:', data.firstName, data.lastName);
      console.log('groupMembers count:', (data.groupMembers || []).length);
      (data.groupMembers || []).forEach((m, i) => {
        console.log('  Member', i, ':', m.firstName, m.lastName, 'meal:', m.mealPlan, 'shirt:', m.shirtSize, 'age:', m.age, 'gender:', m.gender, 'pyc:', m.pycCount);
      });
    }
    const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Early bird ends April 15, 2026 at 11:59 PM Philippine Time (UTC+8)
    const EARLY_BIRD_DEADLINE = new Date('2026-04-15T23:59:59+08:00');
    const now = new Date();
    const isEarlyBird = now <= EARLY_BIRD_DEADLINE;

    // Early bird: vegetarian ₱1,750 / vegan ₱2,100 / without meal ₱750
    // Regular:    vegetarian ₱1,850 / vegan ₱2,200 / without meal ₱850
    const PRICES = isEarlyBird
      ? { withMeal: 1750, vegan: 2100, noMeal: 750 }
      : { withMeal: 1850, vegan: 2200, noMeal: 850 };

    const MEAL_PRICES = {
      'vegan': PRICES.vegan,
      'vegetarian': PRICES.withMeal,
      'none': PRICES.noMeal
    };
    const BASE_PRICE = 0; // price is all-inclusive now, no separate base+meal
    const registrationType = data.registrationType || 'individual';
    const isGroup = registrationType === 'group';
    const groupId = isGroup ? uuidv4() : null;

    // Build primary registrant data
    function buildRegistrationData(personData, isPrimary) {
      const mealPrice = MEAL_PRICES[personData.mealPlan] || 0;
      const totalAmount = mealPrice; // all-inclusive pricing

      const regData = {
        first_name: personData.firstName,
        last_name: personData.lastName,
        nickname: personData.nickname || null,
        email: isPrimary ? data.email : data.email, // all group members share primary email
        phone: isPrimary ? data.phone : data.phone,
        gender: personData.gender || null,
        age: personData.age,
        pyc_count: isPrimary ? (data.pycCount || null) : (personData.pycCount || null),
        location_type: data.locationType,
        tshirt_size: personData.shirtSize || personData.shirtSize,
        meal_plan: personData.mealPlan,
        volunteer: 'No',
        volunteer_role: null,
        referral_source: isPrimary ? data.referralSource : data.referralSource,
        other_source: isPrimary ? (data.otherSource || null) : null,
        minor_waiver_accept: data.minorWaiverAccept || null,
        registration_fee: 0,
        meal_fee: 0,
        total_amount: totalAmount,
        pricing_type: isEarlyBird ? 'early_bird' : 'regular',
        payment_status: 'Pending',
        registration_type: registrationType,
        group_id: groupId,
        is_primary: isPrimary
      };

      // Add address fields for primary only
      if (isPrimary) {
        if (data.locationType === 'philippines') {
          if (data.vipStreet) {
            regData.street = data.vipStreet || null;
            regData.barangay = data.vipBarangay || null;
            regData.city = data.vipCity || null;
            regData.province = data.vipProvince || null;
            regData.region = data.vipRegion || null;
            regData.postal_code = data.vipZipCode || null;
          } else {
            regData.region = data.phRegion || null;
            regData.city = data.phCity || null;
          }
        }
        if (data.locationType === 'international') {
          regData.country = data.intCountry || null;
          regData.city = data.intCity || null;
        }
      } else {
        // Copy location from primary for group members
        if (data.locationType === 'philippines') {
          regData.region = data.phRegion || data.vipRegion || null;
          regData.city = data.phCity || data.vipCity || null;
        }
        if (data.locationType === 'international') {
          regData.country = data.intCountry || null;
          regData.city = data.intCity || null;
        }
      }

      return regData;
    }

    // Insert primary registrant
    const primaryData = buildRegistrationData({
      firstName: data.firstName,
      lastName: data.lastName,
      nickname: data.nickname,
      age: data.age,
      gender: data.gender,
      shirtSize: data.shirtSize,
      mealPlan: data.mealPlan
    }, true);

    const { data: primaryRecord, error: primaryError } = await supabase
      .from('registrations')
      .insert([primaryData])
      .select()
      .single();

    if (primaryError) {
      console.error('Primary insert error:', primaryError);
      throw new Error('Failed to create registration: ' + primaryError.message);
    }

    const registrationNumber = primaryRecord.id;
    let totalGroupAmount = primaryRecord.total_amount;
    const memberIds = [registrationNumber];
    let memberInsertErrors = [];


    // === Round-robin payment account assignment ===
    // Count existing primary/individual registrations to determine which account set
    let paymentAccount = 'A'; // default
    try {
      // Count registrations that are either individual or group primary
      const { count, error: countError } = await supabase
        .from('registrations')
        .select('*', { count: 'exact', head: true })
        .or('registration_type.eq.individual,is_primary.eq.true');
      
      if (!countError && count !== null) {
        // Use modulo: even count = A, odd count = B
        // (count includes the one we just inserted, so if count=1 -> first reg -> A)
        const accounts = ['A', 'B', 'C', 'D', 'E'];
        paymentAccount = accounts[count % 5];
      }
    } catch (countErr) {
      console.error('Count error for account assignment:', countErr);
    }

    // Update the primary record with assigned payment account
    await supabase
      .from('registrations')
      .update({ payment_account: paymentAccount })
      .eq('id', registrationNumber);

    // Insert group members if group registration
    if (isGroup && data.groupMembers && data.groupMembers.length > 0) {
      console.log('===== GROUP MEMBER INSERT START =====');
      console.log('Total members to insert:', data.groupMembers.length);
      console.log('Members received:', JSON.stringify(data.groupMembers.map((m,i) => ({idx:i, name: m.firstName + ' ' + m.lastName, meal: m.mealPlan, shirt: m.shirtSize, age: m.age}))));
      
      for (let i = 0; i < data.groupMembers.length; i++) {
        const member = data.groupMembers[i];
        console.log('--- Inserting member', (i+1), 'of', data.groupMembers.length, ':', member.firstName, member.lastName, '---');
        const memberData = buildRegistrationData({
          firstName: member.firstName,
          lastName: member.lastName,
          nickname: member.nickname,
          age: member.age,
          gender: member.gender,
          shirtSize: member.shirtSize,
          mealPlan: member.mealPlan,
          pycCount: member.pycCount,
          volunteer: member.volunteer
        }, false);

        // Try up to 2 times
        let inserted = false;
        for (let attempt = 1; attempt <= 2 && !inserted; attempt++) {
          try {
            console.log('Attempt', attempt, 'for member', member.firstName, member.lastName);
            console.log('Member data:', JSON.stringify(memberData));
            const { data: insertedMember, error: memberError } = await supabase
              .from('registrations')
              .insert([memberData])
              .select()
              .single();
            
            if (memberError) {
              console.error('Member insert error (attempt', attempt, ') for', member.firstName, member.lastName, ':', memberError.message, memberError.code, memberError.details);
              if (attempt === 2) memberInsertErrors.push(member.firstName + ' ' + member.lastName + ': ' + memberError.message);
            } else if (insertedMember) {
              console.log('SUCCESS: Inserted member', (i+1), ':', insertedMember.first_name, insertedMember.last_name, 'ID:', insertedMember.id, 'group_id:', insertedMember.group_id);
              totalGroupAmount += insertedMember.total_amount;
              memberIds.push(insertedMember.id);
              await supabase.from('registrations').update({ payment_account: paymentAccount }).eq('id', insertedMember.id);
              inserted = true;
            }
          } catch (e) {
            console.error('Member insert exception (attempt', attempt, ') for', member.firstName, member.lastName, ':', e.message);
            if (attempt === 2) memberInsertErrors.push(member.firstName + ' ' + member.lastName + ': ' + e.message);
          }
        }
      }
    }

    // Get registrant number (count of primary registrations)
    let registrantNumber = 0;
    try {
      const { count: regCount } = await supabase
        .from('registrations')
        .select('*', { count: 'exact', head: true })
        .eq('is_primary', true);
      registrantNumber = regCount || 0;
    } catch (e) { console.error('Count error:', e.message); }

    // NOTE: PYC confirmation numbers are NOT assigned at registration.
    // They are assigned when payment proof is uploaded (upload-payment-proof.js)
    // This prevents wasting PYC numbers on abandoned registrations.
    let primaryConfNum = '';

    // VERIFY: Query back all members with this group_id to confirm they exist
    let verifiedCount = 0;
    if (isGroup && groupId) {
      try {
        const { data: verified, error: verifyError } = await supabase
          .from('registrations')
          .select('id, first_name, last_name, group_id')
          .eq('group_id', groupId);
        verifiedCount = verified ? verified.length : 0;
        console.log('VERIFICATION: Found', verifiedCount, 'records with group_id', groupId);
        if (verified) verified.forEach(v => console.log('  Verified:', v.first_name, v.last_name, v.id));
        
        // If members are missing, log detailed warning
        if (verifiedCount < memberIds.length) {
          console.error('WARNING: Expected', memberIds.length, 'but found', verifiedCount, 'in database!');
        }
      } catch (e) { console.error('Verification error:', e.message); }
    }

    // Log final state for debugging
    console.log('Registration complete:', {
      registrationNumber,
      groupId,
      totalMembers: memberIds.length,
      membersRequested: isGroup ? (data.groupMembers || []).length + 1 : 1,
      totalGroupAmount,
      memberInsertErrors
    });

    return {
      statusCode: 200,
      body: JSON.stringify({
        success: true,
        registrationNumber: registrationNumber,
        registrantNumber: registrantNumber,
        confirmationNumber: primaryConfNum,
        groupId: groupId,
        totalAmount: totalGroupAmount,
        memberCount: memberIds.length,
        membersRequested: isGroup ? (data.groupMembers || []).length : 0,
        memberInsertErrors: memberInsertErrors,
        paymentAccount: paymentAccount,
        message: isGroup
          ? `Group registration successful! ${memberIds.length} members registered.`
          : 'Registration successful! Please complete payment.'
      })
    };

  } catch (error) {
    console.error('Registration error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Registration failed', message: error.message })
    };
  }
};
