const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event, context) => {
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      body: JSON.stringify({ error: 'Method not allowed' })
    };
  }

  try {
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    // Get ALL registrations. PostgREST caps each request at 1000 rows, so a plain
    // select('*') would only count the first 1000 and undercount the stats (and
    // therefore meal/t-shirt planning). Page through until all rows are fetched.
    const PAGE = 1000;
    let registrations = [];
    let from = 0;
    while (true) {
      const { data, error } = await supabase
        .from('registrations')
        .select('*')
        .range(from, from + PAGE - 1);
      if (error) {
        console.error('Stats error:', error);
        throw new Error('Failed to fetch statistics: ' + error.message);
      }
      const batch = data || [];
      registrations = registrations.concat(batch);
      if (batch.length < PAGE) break;
      from += PAGE;
      if (from > 100000) break;
    }

    // Calculate statistics
    // "total" = people who have SUBMITTED payment proof (Paid + Pending Review).
    // All sub-stats (gender, location, age, meal, shirt) also count only this group —
    // unpaid/rejected/cancelled people are excluded from every breakdown.
    const paidCount = registrations.filter(r => r.payment_status === 'Paid').length;
    const pendingReviewCount = registrations.filter(r => r.payment_status === 'Pending Review').length;

    // This is the filtered set used for EVERY sub-stat below.
    const paid = registrations.filter(r =>
      r.payment_status === 'Paid' || r.payment_status === 'Pending Review'
    );

    const stats = {
      total: paidCount + pendingReviewCount,
      paid: paidCount,
      pendingReview: pendingReviewCount,
      checkedIn: paid.filter(r => r.checked_in === true).length,
      locations: {
        luzon: paid.filter(r => r.location_type === 'philippines' && r.region === 'Luzon').length,
        visayas: paid.filter(r => r.location_type === 'philippines' && r.region === 'Visayas').length,
        mindanao: paid.filter(r => r.location_type === 'philippines' && r.region === 'Mindanao').length,
        international: paid.filter(r => r.location_type === 'international').length
      },
      genders: {
        male: paid.filter(r => r.gender === 'Male').length,
        female: paid.filter(r => r.gender === 'Female').length
      },
      pycAttendance: {
        '1st': paid.filter(r => r.pyc_count === '1st').length,
        '2nd': paid.filter(r => r.pyc_count === '2nd').length,
        '3rd': paid.filter(r => r.pyc_count === '3rd').length,
        '4th': paid.filter(r => r.pyc_count === '4th').length,
        '5th': paid.filter(r => r.pyc_count === '5th').length,
        '6th': paid.filter(r => r.pyc_count === '6th').length,
        '7th+': paid.filter(r => r.pyc_count === '7th+').length
      },
      // Age keys match the values stored in the DB (from register.html select options).
      ageGroups: {
        '0-8':   paid.filter(r => r.age === '0-8').length,
        '9-13':  paid.filter(r => r.age === '9-13').length,
        '14-17': paid.filter(r => r.age === '14-17').length,
        '18-25': paid.filter(r => r.age === '18-25').length,
        '26-35': paid.filter(r => r.age === '26-35').length,
        '36+':   paid.filter(r => r.age === '36+').length
      },
      mealPlans: {
        full: paid.filter(r => r.meal_plan === 'full').length,
        half: paid.filter(r => r.meal_plan === 'half').length
      },
      tshirtSizes: {
        xs:   paid.filter(r => r.tshirt_size === 'xs').length,
        s:    paid.filter(r => r.tshirt_size === 's').length,
        m:    paid.filter(r => r.tshirt_size === 'm').length,
        l:    paid.filter(r => r.tshirt_size === 'l').length,
        xl:   paid.filter(r => r.tshirt_size === 'xl').length,
        '2xl': paid.filter(r => r.tshirt_size === '2xl').length,
        '3xl': paid.filter(r => r.tshirt_size === '3xl').length
      },
      volunteers: registrations.filter(r => r.payment_status === 'Volunteer').length
    };

    return {
      statusCode: 200,
      body: JSON.stringify(stats)
    };

  } catch (error) {
    console.error('Admin stats error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: 'Failed to fetch statistics',
        message: error.message
      })
    };
  }
};
