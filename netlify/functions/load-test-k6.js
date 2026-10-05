/**
 * PYC 2026 — External Load Test (k6)
 * 
 * SETUP:
 *   brew install k6          (macOS)
 *   choco install k6         (Windows)
 *   sudo apt install k6      (Linux)
 *   Or: https://k6.io/docs/get-started/installation
 * 
 * RUN:
 *   k6 run load-test-k6.js                          (default: 10 users, 30s)
 *   k6 run --vus 50 --duration 60s load-test-k6.js  (50 users, 60s)
 *   k6 run --vus 100 --duration 120s load-test-k6.js (heavy load)
 * 
 * CHANGE THIS to your actual site URL:
 */
const BASE_URL = 'https://philippineyouthforchrist.org';

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const registrationTime = new Trend('registration_time');
const searchTime = new Trend('search_time');
const availabilityTime = new Trend('availability_time');

// Test configuration
export const options = {
  vus: 10,           // virtual users
  duration: '30s',   // test duration
  thresholds: {
    http_req_duration: ['p(95)<5000'],  // 95% of requests under 5s
    errors: ['rate<0.1'],                // less than 10% errors
  },
};

const NAMES_FIRST = ['Juan','Maria','Jose','Ana','Pedro','Rosa','Miguel','Carmen','Luis','Elena','Carlos','Sofia','Diego','Isabella','Marco'];
const NAMES_LAST = ['DelaCruz','Santos','Reyes','Garcia','Ramos','Cruz','Fernandez','Torres','Flores','Rivera'];
const SIZES = ['xs','s','m','l','xl','2xl'];
const MEALS = ['vegan','vegetarian','none'];
const GENDERS = ['Male','Female'];
const AGES = ['13-17','18-25','26-35'];

function rand(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

export default function () {
  const scenario = Math.random();

  if (scenario < 0.4) {
    // 40% — Registration flow
    testRegistration();
  } else if (scenario < 0.7) {
    // 30% — Search
    testSearch();
  } else if (scenario < 0.9) {
    // 20% — Accommodation availability
    testAccommodation();
  } else {
    // 10% — Admin list
    testAdminList();
  }

  sleep(Math.random() * 2 + 0.5); // 0.5-2.5s between requests
}

function testRegistration() {
  const payload = JSON.stringify({
    firstName: rand(NAMES_FIRST),
    lastName: 'STRESSTEST-' + Math.random().toString(36).substring(2, 8),
    email: `k6test${Date.now()}${Math.random().toString(36).substring(2,6)}@test.pyc2026.com`,
    phone: '09' + Math.floor(Math.random() * 1000000000).toString().padStart(9, '0'),
    age: rand(AGES),
    gender: rand(GENDERS),
    shirtSize: rand(SIZES),
    mealPlan: rand(MEALS),
    pycCount: '1st',
    locationType: 'philippines',
    phRegion: 'Mindanao',
    phCity: 'Valencia',
    referralSource: 'other',
    otherSource: 'k6-load-test',
    registrationType: 'individual'
  });

  const res = http.post(`${BASE_URL}/.netlify/functions/submit-registration`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  const success = check(res, {
    'registration status 200': (r) => r.status === 200,
    'registration has success': (r) => JSON.parse(r.body).success === true,
  });

  errorRate.add(!success);
  registrationTime.add(res.timings.duration);
}

function testSearch() {
  const payload = JSON.stringify({
    query: rand(NAMES_FIRST),
    searchType: 'name'
  });

  const res = http.post(`${BASE_URL}/.netlify/functions/admin-search`, payload, {
    headers: { 'Content-Type': 'application/json' },
  });

  check(res, { 'search status 200': (r) => r.status === 200 });
  errorRate.add(res.status !== 200);
  searchTime.add(res.timings.duration);
}

function testAccommodation() {
  const res = http.get(`${BASE_URL}/.netlify/functions/accommodation-availability`);
  check(res, { 'availability status 200': (r) => r.status === 200 });
  errorRate.add(res.status !== 200);
  availabilityTime.add(res.timings.duration);
}

function testAdminList() {
  const res = http.get(`${BASE_URL}/.netlify/functions/admin-list-all`);
  check(res, { 'admin-list status 200': (r) => r.status === 200 });
  errorRate.add(res.status !== 200);
}
