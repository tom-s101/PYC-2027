const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
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
    // Get client IP address
    const clientIP = event.headers['x-forwarded-for'] || 
                     event.headers['x-real-ip'] || 
                     'unknown';

    // Get geolocation data from ipapi.co (free API)
    let locationData = {
      ip_address: clientIP,
      country: null,
      city: null,
      latitude: null,
      longitude: null
    };

    try {
      const geoResponse = await fetch(`https://ipapi.co/${clientIP}/json/`);
      if (geoResponse.ok) {
        const geoData = await geoResponse.json();
        locationData = {
          ip_address: clientIP,
          country: geoData.country_name || null,
          country_code: geoData.country_code || null,
          city: geoData.city || null,
          region: geoData.region || null,
          latitude: geoData.latitude || null,
          longitude: geoData.longitude || null
        };
      }
    } catch (geoError) {
      console.error('Geolocation API error:', geoError);
      // Continue with limited data
    }

    // Store in Supabase
    const supabase = createClient(
      process.env.SUPABASE_URL,
      process.env.SUPABASE_SERVICE_KEY
    );

    const { error: insertError } = await supabase
      .from('visitor_analytics')
      .insert({
        ip_address: locationData.ip_address,
        country: locationData.country,
        country_code: locationData.country_code,
        city: locationData.city,
        region: locationData.region,
        latitude: locationData.latitude,
        longitude: locationData.longitude,
        visited_at: new Date().toISOString()
      });

    if (insertError) {
      console.error('Database insert error:', insertError);
      // Don't return error to client - tracking is non-critical
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ success: true })
    };

  } catch (error) {
    console.error('Visitor tracking error:', error);
    return {
      statusCode: 200, // Return 200 even on error so site continues loading
      headers,
      body: JSON.stringify({ success: false })
    };
  }
};
