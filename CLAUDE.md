# CLAUDE.md — PYC 2026/2027 Registration System

> **Purpose of this file:** Full project context for Claude Code. Read this first before
> making any change. It captures the architecture, conventions, hard-won lessons, data
> model, and the in-progress 2027 redesign so work can continue without losing context.

---

## 1. WHAT THIS IS

A full-stack conference registration, payment, accommodation, and check-in system for
**Philippine Youth for Christ (PYC)** — a Seventh-day Adventist youth ministry event.

- **Event:** PYC 2027 — "Abide" (John 15:4, KJV on the site)
- **Dates:** June 2–6, 2027 · opening night 6:00 PM Philippine Time
- **Venue:** SMX Convention Center Davao, Davao City, Mindanao, Philippines
- (Previous: PYC 2026 — "Above and Beyond", June 3–7, 2026, Mountain View College)
- **Audience:** SDA youth and young adults
- **Public site:** https://philippineyouthforchrist.org
- **Status:** Live and handling real registrations. A 2027 redesign (`register-v2`) is in progress.

The sole developer works **exclusively from an iPad** (Safari + GitHub web interface).
There is **no local dev environment and no browser DevTools console.** This constraint
drives many decisions below — respect it.

---

## 2. TECH STACK

| Layer | Technology |
|---|---|
| Frontend | Static HTML/CSS/JS, no framework |
| Hosting | Netlify (static + Netlify Functions for serverless backend) |
| Database | Supabase (PostgreSQL) |
| Email | Brevo (transactional email API) |
| Notifications | Telegram Bot API |
| CDN / DNS | Cloudflare |
| Domain | philippineyouthforchrist.org (Namecheap) |
| Payments | Manual — GCash (round-robin accounts) + Bank Transfer (BDO, BPI) |
| PDF / posters | Python + reportlab |
| Video | Remotion (tutorial videos) |
| Deployment | GitHub web interface → Netlify auto-deploy |

**Repo layout (Netlify convention):**
- `public/` — all HTML/CSS/JS served to browsers
- `netlify/functions/` — serverless backend functions (one file = one endpoint)

---

## 3. CRITICAL CONVENTIONS & HARD-WON LESSONS

**These are not style preferences — violating them has caused real production bugs.**

### 3.1 iPad Safari — native `confirm()` and `alert()` SILENTLY FAIL
This is the #1 recurring "the button doesn't work" bug. On iPad Safari, native
`confirm()` / `alert()` often return `false` / do nothing without error. **Every
confirm/alert must use a custom modal.** Each page has its own helper:
- `ciConfirm` (checkin.html)
- `adminConfirm(message, okLabel)` (admin-dashboard.html) — returns a Promise
- `arCustomConfirm` / `arCustomAlert` (ar.html)
- `pycCustomConfirm` / `pycCustomAlert` (md.html)
- `acConfirm` / `acAlert` (ac.html)

`window.prompt()` **does** work on iPad Safari and is used (e.g. ac.html room move).

### 3.2 Supabase/PostgREST caps every query at 1000 rows
A plain `.select('*')` silently returns only the first 1000 rows. This caused people to
go **missing from exports, stats, lists, and counters**. Any query that can exceed 1000
rows MUST paginate:
```js
const PAGE = 1000; let all = []; let from = 0;
while (true) {
  const { data, error } = await supabase.from('table').select('*').range(from, from + PAGE - 1);
  if (error) throw new Error(error.message);
  const batch = data || []; all = all.concat(batch);
  if (batch.length < PAGE) break;
  from += PAGE; if (from > 100000) break; // safety stop
}
```
Functions already fixed this way: `admin-list-all.js`, `admin-stats.js`,
`accommodation-checkin.js` (all_reservations action), `import-room-assignments.js`.

### 3.3 Safari "string did not match the expected pattern" = JSON.parse on non-JSON
When a Netlify function times out (504) or errors (500), it returns an HTML page, and
`JSON.parse` throws this cryptic Safari error. Always parse via `res.text()` then
`JSON.parse` in a try/catch, and show a "tap refresh" message. Helpers: `safeJson`,
`acSafeJson`.

### 3.4 Netlify Functions bundle independently
**No shared modules between functions** — each function must be self-contained. A shared
require that works locally fails silently in the bundled function. (Exception that works:
`email-helper.js` is required by functions that send email — verify it's bundled.)

### 3.5 Surgical edits over rewrites
The developer strongly prefers targeted `str_replace`-style edits. **Do not rewrite whole
files** unless truly necessary. When you must touch a file, change only what's needed and
state what you changed.

### 3.6 The STALE BASELINE TRAP (caused real data loss + anger)
Files in any working copy are often OLDER than what's deployed live. Editing an old copy
and handing it back WIPES newer live features. **Before editing a file that may have
diverged, ask the developer to upload the current deployed version, then diff against it
before re-applying changes.** This has bitten the project multiple times (e.g. the
admin-dashboard Payments tab nearly got wiped).

### 3.7 Other Safari/iPad specifics
- Use `Date.UTC()` for cross-browser date math.
- 16px input font prevents iOS auto-zoom on focus.
- Use `<button onclick>` for click handlers, not anchor `onclick` (anchor+window.open is
  blocked); programmatic `a.click()` for downloads works.
- No console access — all debugging output must be visible **on-screen**.

### 3.8 Validate JS before considering it done
Run `node --check file.js` for functions, and for HTML, extract `<script>` blocks and
`new Function(src)` each to catch syntax errors. The developer cannot see console errors.

### 3.9 Root-cause fixes, not patches
The developer expects definitive fixes addressing the underlying cause, and expects risks
to be flagged proactively *before* proceeding. Stated working principle:
**"Don't break anything, don't change anything else — ask first."**

### 3.10 Inline `onclick` with JSON or escaped strings breaks
Names with apostrophes/quotes break handlers like `onclick="fn('O'Brien')"`. Use `data-*`
attributes plus a small handler wrapper (read `this.dataset.x`) instead of inlining values.

### 3.11 Verify the TARGET file/page before building
Two pairs have caused costly misdirected work: **registration check-in (`checkin.html`)
vs accommodation check-in (`ac.html`)**, and **resubmit-payment vs resubmit-accommodation**.
Confirm which one the developer means before editing.

### 3.12 Finish the job; flag risks first
Expect extended sessions covering many features at once. Complete each task fully, and
raise risks *before* proceeding rather than correcting afterward.

---

## 4. DESIGN / THEME

**2027 theme (current):** Apple-developer-style. Black background, system font stack
(SF Pro on Apple devices, Inter fallback), large tight headlines, full-bleed photos with
text on top, pill buttons. Source of truth: `public/index.html` (the 2027 landing page, formerly home-v2) +
**`public/theme-2027.css`**.

**Accent colours (developer decision):**
- Landing page (`index.html`) keeps the brighter gold `#d4a556`.
- All app pages (registration, payment, accommodation, tenting, dashboards) use a muted
  **sand** `#c9b897` (hover/light `#d9cbb0`, dark `#b5a27f`, rgba form `201,184,151`).
  Headings are white and form labels soft grey; sand is only for buttons, borders, prices
  and small highlights. Do NOT reintroduce gold text on these text-heavy pages.
- Status colours (green paid, red rejected, orange pending) are unchanged.

- `theme-2027.css` is linked as the LAST stylesheet on every app page (one `<link>` line
  just before `</head>`, or before `<body>` in register.html, which has no `</head>`). It
  re-maps `--primary-navy`/`--secondary-gold`, forces the black background, hides the old
  starfield, swaps every font to the system stack, and restyles former Bebas Neue headings.
  **New pages: add that one `<link>` line last in `<head>`.**
- The old navy literals in pages were swapped to neutrals (`#1a2332`→`#1c1c1e`,
  `#0f1419`→`#000`, `#2a3f5f`→`#2c2c2e`, matching `rgba()` forms).
- Photos live in `public/img/` (worship, community, notes, delegates; `-sm` = mobile).
- Not themed on purpose: `index-2026.html` (old 2026 landing, kept only as a backup),
  `special-welcome.html`, `monkey-*.html`, `stress-test.html`, `analytics67.html.html`.

**2026 theme (legacy, for reference):**

- **Fonts:** `Bebas Neue` for headings (with `letter-spacing`), `Montserrat` for body.
  (The older `Cinzel` serif was replaced by Bebas Neue; some legacy pages may still
  reference it. The developer's stated convention also lists `Cormorant Garamond` for
  input fields, but the current register-v2 shell uses Montserrat for inputs — confirm
  which to use before standardizing. See `register-v2-regfox-layout.md` §9.)
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=Montserrat:wght@300;400;500;600;700;800;900&display=swap" rel="stylesheet">
  ```
- **Colors:** navy `#1a2332`, gold `#d4a556` (`--secondary-gold`), light `#f5f5f5`.
- **Background:** `linear-gradient(135deg, #0f1419 0%, #1a2332 50%, #2a3f5f 100%)` with
  `background-attachment: fixed`.
- **Mobile-first:** most check-in happens on phones. Big tap targets (44–54px), 2×2 tab
  grids, cards that stack to one column on narrow screens, no horizontal overflow.
- Paper/ink-efficient formatting is preferred for any printed material.

---

## 5. DATA MODEL (Supabase tables)

### `registrations` (the core table)
One row per person. Group members are separate rows sharing the primary's `email` +
`group_id`, with `is_primary` on the primary.
Key fields: `id`, `confirmation_number` (the PYC code, e.g. `PYC-0487`), `first_name`,
`last_name`, `email`, `phone`, `gender` (`Male`/`Female`), `age` (string range, see
below), `pyc_count` (`1st`..`7th+`), `location_type` (`philippines`/`international`),
`region` (`Luzon`/`Visayas`/`Mindanao` for PH; null for intl), `city`, `country`,
plus VIP address fields (`street`, `barangay`, `province`, `postal_code`),
`tshirt_size` (`xs,s,m,l,xl,2xl,3xl,4xl,5xl`), `meal_plan` (`full`/`half`),
`volunteer` (`Yes`/`No`), `volunteer_role`, `referral_source`, `other_source`,
`minor_waiver_accept`, `registration_fee`, `meal_fee`, `total_amount`,
`payment_status`, `payment_proof_url`, `payment_proof_uploaded_at`,
`payment_method`, `payment_account` (a CODE — see §7), `transaction_reference`,
`checked_in` (bool), `checked_in_at`, `reminder_sent_at`, `group_id`, `is_primary`,
`registration_type` (`individual`/`group`), `created_at`.

**Age values (IMPORTANT — exact strings):** `0-8`, `9-13`, `14-17`, `18-25`, `26-35`,
`36+`. Minors = `0-8`, `9-13`, `14-17` (trigger the minor waiver). An earlier migration
moved off the old `0-5/6-12/13-19/20-35` scheme — do NOT reintroduce those keys. A stats
bug where the backend used the old keys caused all-zero age counts; keys must match the DB.

**Payment statuses:** `Pending` (registered, not paid), `Pending Review` (proof uploaded,
awaiting approval), `Paid` (approved), `Rejected`, `Cancelled`, `Volunteer`.
"Attending headcount" = **Paid + Pending Review** (this is what exports & stats count).

### `accommodation_reservations`
`id`, `registration_id`, `registrant_name`, `registrant_email`, `accommodation_type`,
`spots_requested`, `payment_status`, `checked_in`, `checked_in_at`, `room_assignment`
(free-text), `transaction_reference`, `payment_method`, `payment_account`.

### `accommodation_types`
`id`, `display_name`, `total_units`, `capacity_per_unit`, `is_active`.

### `room_assignments` (person-level room map)
One row per ROOM: `{ id, hall, room_number, gender, members (JSONB array), capacity,
is_locked }`. Each member object: `{ name, pycNumber, registrationId, phone, gender }`.
Linked to `registrations` via `member.registrationId`. **Check-in status is NOT stored
here** — it lives on `accommodation_reservations.checked_in`; cross-reference by
registrationId/PYC.

### `tent_reservations`
Booker-level: `registrant_name`, `registrant_email`, `tent_size`, `canopy_number`,
`tent_group_type` (`married`/`family`/`friends`/`solo`), `members` (array),
`total_amount`, `payment_status`, `transaction_reference`, plus group-type clustering.

### `roommate_requests`
Roommate pairing requests (managed via ar.html + admin functions).

### Halls config (in `auto-assign-rooms.js`)
Onyx (Male, 100), Emerald (Male, 88), Pearl (Female, 100), Amethyst (Female, 148);
roomSize 4. Auto-assign clusters by gender; respects locked rooms and whitelists.

---

## 6. PRICING

All-inclusive per person, chosen by meal plan (`meal_plan` = `vegan`/`vegetarian`/`none`;
`registration_fee`/`meal_fee` are 0, `total_amount` holds the price). **Confirmed by the
developer: 2027 uses the same prices as 2026.**

| Meal plan | Early bird | Regular |
|---|---|---|
| `vegan` (Full Meal — Vegan) | 2100 | 2200 |
| `vegetarian` (Full Meal — Vegetarian) | 1750 | 1850 |
| `none` (Without Meal) | 750 | 850 |

`pricing_type` = `early_bird`/`regular`. Early-bird deadline: 2026 was Apr 15 11:59 PM PHT;
**2027 is Apr 15, 2027 11:59 PM PHT** (in `register-v2.html` and
`submit-registration-with-payment.js` — keep both in sync). Live 2026 files
(`register.html`, `payment.html`, `submit-registration.js`, `email-helper.js`) still carry the
2026 deadline; the developer will update those later.

---

## 7. PAYMENT ACCOUNTS (round-robin)

`payment_account` is stored as a **CODE**, not a name. The name mapping lives in
`payment.html` (and is mirrored in `admin-dashboard.html` as `PAYMENT_ACCOUNT_LABELS`):

| Code | Receiver |
|---|---|
| A | Febie Gemere Gacusan (GCash) |
| B | Alpha Beth Fofue (GCash) |
| C | Ydjean Joy Dela Cruz (GCash) |
| D | Dorothy Claire Manata (GCash) |
| E | Georgia Sanchez (GCash) — disabled |
| bank_bdo | Alpha Beth Fofue (BDO) |
| bank_bpi | Febie Gemere Gacusan (BPI) |

`payment.html` assigns a GCash account by round-robin, shows the payer the name+number,
and on proof upload sends `paymentAccount` (the code) + `paymentMethod` +
`transactionReference`. **If you add/change an account in payment.html, update
`PAYMENT_ACCOUNT_LABELS` in admin-dashboard.html too**, or the dashboard shows raw codes.

**PYC confirmation numbers** are zero-padded to 4 digits (`PYC-0487`); users type `487`.
Normalize: strip non-digits → `parseInt` → `PYC-` + `padStart(4,'0')`. Numbers are
assigned **at payment-proof upload time** (in `upload-payment-proof.js`), not at
registration. Group members each get their own sequential number.

---

## 8. PAGES (public/)

| File | Purpose |
|---|---|
| `index.html` | Public landing page — 2027 "Abide" design (theme source of truth); all event facts in its `PYC = {…}` config block |
| `index-2026.html` | Old 2026 landing page, backup only (not linked) |
| `register.html` | **Live** registration form (2026). Two-page flow: form → payment. |
| `payment.html` | Payment page: round-robin GCash assignment + proof upload |
| `accommodations.html` | Public dorm reservation |
| `tenting.html` | Public tent/camping reservation |
| `admin-dashboard.html` | Main admin panel (see tabs below) |
| `md.html` | Master Dashboard (`/md`) — registrant lookup, stats, check-in, undo |
| `ar.html` | Accommodation dashboard (`/ar`) — dorms, tents, import, roommates |
| `checkin.html` | Public registration check-in (mobile-first) |
| `ac.html` | Accommodation check-in (renamed from accommodation-checkin.html) |
| `reminder-email-preview.html` | Preview of the reminder email |
| `register-v2.html` | **NEW 2027** wizard registration (`/register-v2`, not live yet — see §11) |

### admin-dashboard.html tabs (6)
Check-In, GCash Payment Proofs, Resubmissions, All Registrations, **Payments**, Statistics.
- `allRegistrations` cached on login.
- Helpers: `adminConfirm(message, okLabel)`, `showAlert(elementId, msg, type)` (auto-hides
  5s), `formatShirtSize()`, `accountLabel()` + `PAYMENT_ACCOUNT_LABELS`.
- SheetJS (xlsx 0.18.5 CDN) loaded for Excel export.
- **Exports:** "Export to Excel" (full, Paid+Pending Review, with a "Meal & Shirt Totals"
  summary sheet) and "Export Check-In List" (name, shirt, phone, PYC, check-in status;
  sorted A–Z by last name). Both confirm counts via `adminConfirm`, use `showAlert`.
- **GCash Proofs tab** has an account filter (`proofsReceiverFilter`) so each receiver can
  see/approve only their payments; cards show "Paid to: <name>".
- **Payments tab** filters by receiver/method/status/date-range; shows account labels + total.

### checkin.html (registration check-in)
Mobile-first. 2×2 tab grid. Paid + Pending Review shown first (`isPaidStatus`), with a
collapsible "show pending/unapproved". Top counter "X / Y checked in". PYC auto-fill with
`normalizePyc`. Group tab with filter, "Check In All", paid-only members, meal plan shown
per member. `ciConfirm` modal. Theme matches index.html (Bebas Neue, 3-stop gradient).

### ac.html (accommodation check-in)
Search by name/email/reference. Each paid result shows room + roommates + (admin) a Move
button. Room Map with per-hall progress bars, "free beds only" filter, "check in whole
room", straggler highlight (someone in, roommates not). Move/shuffle gated to admins.
Login: tries `accommodation-login`, falls back to `admin-login`; both `ADMIN_USERNAME` and
`CHECKIN_USERNAME` get full access (incl. Move). iPad-safe `acConfirm`/`acAlert`/`acSafeJson`.

### ar.html (accommodation dashboard)
Tabs: Dorms, Tenting, Roommates, **Import Assignments**, + more. Dorm export (CSV) and
**tent export** (real .xlsx via SheetJS: "Tents" sheet booker-level + "Campers" sheet
per-person headcount). **Import Assignments tab** uploads the Google Sheet (see §10).

### md.html (master dashboard)
Registrant lookup, full stats (reads correct backend field names — `genders`, `ageGroups`,
`locations`, `pycAttendance`, `mealPlans`, `tshirtSizes`), check-in + undo. `pycCustom*`
modals.

---

## 9. BACKEND FUNCTIONS (netlify/functions/)

**Registration & payment:** `submit-registration.js` (creates row, status Pending),
`upload-payment-proof.js` (adds proof, flips to Pending Review, assigns PYC, sends email +
Telegram, saves payment_account/method/reference), `approve-payment.js`,
`approve-resubmission.js`, `email-helper.js` (`sendConfirmationEmail`).

**Admin/list/stats:** `admin-login.js` (accepts `ADMIN_USERNAME`/`ADMIN_PASSWORD` → role
`admin`, and `CHECKIN_USERNAME`/`CHECKIN_PASSWORD` → role `checkin`; both return
success+sessionToken), `admin-validate-session.js`, `admin-logout.js`, `admin-list-all.js`
(paginated), `admin-stats.js` (paginated; counts **Paid+Pending Review only** for all
sub-stats; age keys match DB), `admin-checkin.js`, `admin-search.js`,
`md-registrant-full.js` (search, limit 30), various `admin-*` utilities (assign-pyc,
update-gender, update-registration, send-email, pyc-lookup, registrant-details, etc.).

**Accommodation:** `submit-accommodation.js`, `accommodation-login.js` (NOT in working
copies — credentials unknown, ask developer), `accommodation-checkin.js` (search/checkin/
undo/stats + **`all_reservations`** action used by ac.html room map), `accommodation-stats.js`,
`auto-assign-rooms.js` (GET returns `halls = {hallName:[rooms]}`; POST `move_member`
`{sourcePyc, targetHall, targetRoomNumber}`; respects locked rooms; backfill caps at hall
people-limit; suppresses ghost under-booking spots), `cancel-reservation.js`,
`import-room-assignments.js` (see §10), roommate functions
(`admin-create-roommate-request.js`, `admin-remove-from-roommate.js`).

**Tents:** `submit-tent.js` (+ group-type clustering, solo-tent whitelist).

**Email/reminders:** `send-reminder.js` (resumable batched sender; `reminder_sent_at`
column tracks who's been emailed; counts via `count:'exact'`; sends to Paid only;
admin-dashboard loops calling it until `done`). `resend-emails.js`. `server-time.js`.

**Telegram:** notifications fire from `upload-payment-proof.js` on proof submission.

---

## 10. ROOM ASSIGNMENT IMPORT (Google Sheet → DB)

The developer maintains room assignments in a Google Sheet **PYC2026_RoomAssignments**,
tab "Room Assignments". Structure:
- Row 1: merged title "ROOM ASSIGNMENTS"
- Row 2 headers: `A:Dormitory`, `B:Room #`, `C:Counting#`, `D:Name`, `E:PYC Number`,
  `F:Room Contact`, `G:Locked`, `H:WALK IN REG`, `I:Volunteers`, `J:Arrival Date`, `K:Note`
- Data e.g. `Onyx | 118 | 1 | Jiro Alpajando | PYC-0187 | 099944818658 | No`
- Halls: Onyx, Emerald, Pearl, Amethyst

**Flow:** ar.html "Import Assignments" tab → developer exports the sheet as .xlsx/.csv →
client-side SheetJS parse (auto-detects header row 2, skips title) → dry-run preview
(matched/unmatched by PYC) → commit. `import-room-assignments.js` looks up `registrationId`
+ gender per PYC, builds rooms keyed `hall|roomNumber`, **merges** (insert new, update
existing unlocked, **skip locked**), reports unmatched PYCs. Matching is by
`confirmation_number` exact (PYC-0187 format).

---

## 11. THE 2027 REDESIGN (register-v2) — IN PROGRESS

Full spec in `register-v2-spec.md`. Built **fresh and parallel**; current registration
stays live and untouched until v2 is proven.

### Decisions (locked)
- **One-page wizard, 3 steps:** Info → Payment → Upload Proof, no page reloads.
- **NOTHING saved to DB until payment proof is submitted.** All info held in the browser
  (`formData` object); a single combined commit at the final upload step. This kills the
  duplicate/dead-record problem (tab-closers never create rows).
- **Browser-side image compression:** ~1400px longest side, JPEG quality 0.8 (kept
  readable — screenshots must stay legible). Only compress if >800KB. Fallback 1600px/0.85.
  This makes the combined info+image request small (~500KB) and safe (the real cause of
  past upload failures was the 4MB raw image, not the text data).
- **Groups:** all members entered first, held in browser, committed together with shared
  `group_id`.
- **QR code:** email-only, generated when admin **approves** payment (status→Paid). Encodes
  the **plain PYC number** (trust-based event; signed token declined). Use `qrcode` npm in
  the approval email function, embed as inline base64.
- **All current fields stay REQUIRED.** **Gender bug fixed:** current register.html only
  had `required` on the Male radio; v2 validates gender explicitly in JS.
- **Merged backend (to build):** `submit-registration-with-payment.js` does what
  `submit-registration.js` + `upload-payment-proof.js` do, in one commit at proof time.

### Build order (from the spec)
1. ✅ **Wizard shell** (`public/register-v2.html`).
2. ✅ **Reorder Step 1 + option cards + live running total** — options first (meal cards
   with early-bird strike-through, t-shirt), then who/contact/address/questions; sticky
   running total; sticky top bar (Register · Check my status → "coming soon" modal ·
   Contact → Facebook); one input font (Montserrat). Early-bird tier uses `server-time.js`.
3. ✅ Browser-side image compression — `compressImage()`: >800 KB or non-JPG/PNG/WebP
   (e.g. HEIC) → canvas, 1400px longest side, JPEG 0.8. Checked on a phone-size receipt:
   reference numbers and 9px small print stay legible.
4. ✅ `submit-registration-with-payment.js` — validates everything server-side, recomputes
   prices (24h early-bird grace if the client saw early prices), duplicate check on
   email + transaction reference (safe to retry), uploads image to `payment-proofs/v2-<uuid>`,
   inserts ALL rows in one multi-row insert as `Pending Review`, assigns PYC numbers with the
   cap-proof allocator (copied from approve-payment.js), sends confirmation email + Telegram.
5. ✅ Group flow — "Add another registrant" blocks (collapsible, removable); members share
   contact/location/payment; minor waiver shows if ANY registrant is under 18 (moved next to
   Terms so it appears after members are added). Payload: `{shared, registrants[], payment,
   imageBase64}`.
6. ✅ QR in the approval email — `email-helper.js` receipt (approval + PYC-correction emails)
   shows a QR image from the new `qr.js` function (`/.netlify/functions/qr?c=PYC-0487`,
   `qrcode` npm). Hosted image instead of inline base64 because Gmail blocks `data:` images;
   the PYC number is printed under it as a fallback.
7. End-to-end test in parallel with live system (local harness run passed; still needs a real
   Netlify deploy-preview test against Supabase/Brevo).
8. Switch register.html → register-v2 only when fully verified.

GCash account in v2: no DB row exists before submit, so the browser picks one of A–D at
random (kept per tab in sessionStorage `v2PaymentAccount`) instead of the server-side count.

### RegFox layout integration (researched; build-ready spec in `register-v2-regfox-layout.md`)
The developer asked to redesign registration to follow RegFox's professional structure.
Research (live RegFox event pages: RightNow Conference 2026, IDABO Education Institute
2026, plus RegFox docs) is in `regfox-redesign-exploration.md`. Summary:
- **Core pattern:** RegFox asks *"what are you buying"* before *"who are you."* Priced
  option cards (tickets/add-ons) come first; personal info and payment come last; one
  Submit button; "Add Another Registrant" for groups; confirmation page + emailed QR that
  their check-in app scans.
- **Adopt (structure):** options-first ordering in Step 1; meal plan as priced option
  cards; a live running total (sticky bar) reused by the Step 2 summary; "Add another
  registrant" group blocks; calm confirmation screen; optional sticky help bar.
- **Keep PYC identity (theme):** Bebas Neue / Montserrat, navy + gold, 3-stop gradient.
  Do NOT copy RegFox's generic white/blue visual style.
- **Do not copy:** coupon codes, live card checkout, billing-address blocks, sponsor rows,
  upsells/merch (payment stays manual GCash/bank + proof upload).
- **Deliberate difference from RegFox:** QR is emailed only after admin approval, not shown
  on the confirmation screen.
- **Architecture unchanged:** nothing saves until proof upload; browser-held state; one
  combined commit; compression; merged backend. This is a reorder + visual treatment of
  Step 1 inside the existing wizard shell, not a rebuild.
- **Open questions to confirm before building:** real 2027 meal options/prices (is there a
  "no meal" tier?), whether accommodation/tenting gets bundled in, input font, whether to
  include the sticky top bar now, and whether early-bird/regular date-based pricing returns.

### Future QR system (planned, beyond registration)
- **Check-in QR** in confirmation email → volunteer scans (jsQR, in-browser camera) →
  feeds existing check-in flow (no typing).
- **Meal QR** on name tags → scan → full-screen green (has meal & not yet redeemed) / red.
  Requires a NEW `meal_redemptions` table (`registration_id`, `meal_slot` e.g.
  "Day1-Lunch", `redeemed_at`) to prevent double-dipping. New `meal.html` scan page.
- **Name-tag PDF** generation (reportlab, like the poster generator) with name, PYC, QR,
  room, meal plan, t-shirt — pre-printed, sorted alphabetically.

### Streamlining recommendations given (for reference)
Single-flow registration; instant provisional confirmation; QR check-in; lane separation
(fast lane "I have my QR" vs help lane); pre-printed name tags; separate accommodation /
t-shirt lines; pre-event comms cadence (7d/2d/day-of); self-service status page; payment
deadline reminders.

---

## 12. CAPACITY / PERFORMANCE NOTES

Stress tested via Loader.io. ~2s per registration on Supabase free tier (shared CPU),
~50 registrations/sec at ~100 concurrent. 10K registrations would take ~3–4 min only if
everyone hit submit simultaneously (won't happen). Supabase Pro would roughly halve
latencies. `accommodation-stats` was the slowest (~1.3s). The system comfortably handles
realistic load.

---

## 13. SECURITY

- Admin auth via Netlify env vars: `ADMIN_USERNAME`/`ADMIN_PASSWORD` and
  `CHECKIN_USERNAME`/`CHECKIN_PASSWORD`. Sessions stored in a Supabase table; rate limiting
  (5 attempts), 15-min lockout, secure session tokens, auto-logout on invalid session.
- Supabase service key + Brevo + Telegram tokens live in Netlify env vars (never in repo).
- No PII in console logs (was a past leak — removed). No DevTools anyway.

---

## 14. HOW TO WORK IN THIS REPO (for Claude Code)

1. **Read this file first.** Then read the specific file(s) you'll touch, in full.
2. **Confirm the live version** if a file may have diverged (see §3.6) before editing.
3. **Make surgical edits.** Don't rewrite; change only what's asked. Flag risks first.
4. **Honor the iPad constraints:** custom modals (no native confirm/alert), on-screen
   debugging, 16px inputs, `<button>` handlers, `Date.UTC()`.
5. **Paginate** any Supabase query that can exceed 1000 rows.
6. **Validate** JS (`node --check`) and HTML `<script>` blocks before finishing.
7. **Match the theme** (§4) on any UI.
8. **Counts/exports** use Paid + Pending Review unless told otherwise.
9. **Deploy targets:** HTML → `public/`, functions → `netlify/functions/`. Remind the
   developer of any required Supabase SQL (e.g. `add-reminder-sent-column.sql`) or env vars.
10. **Don't introduce ads, external trackers, or break privacy.** This is a ministry event.

---

## 15. KNOWN SQL / MIGRATIONS

- `add-reminder-sent-column.sql` — adds `reminder_sent_at timestamptz` + index (REQUIRED
  before using the reminder sender). Includes progress-check + reset-all queries.
- Age bracket migration (already run): moved `age` to `0-8/9-13/14-17/18-25/26-35/36+`
  with a CHECK constraint.
- `diagnose-girls-dorms.sql` — a diagnostic query for dorm gender issues.
- Future: `meal_redemptions` table for the 2027 meal-QR system (not yet created).

---

## 16. OPEN ITEMS / NEXT STEPS

- **Next:** deploy-preview test of register-v2 end to end (real Supabase/Brevo/Telegram),
  then switch over. Netlify must install the new `qrcode` dependency (package.json).
- Update the 2026 early-bird date in live `register.html`/`payment.html`/
  `submit-registration.js`/`email-helper.js` (developer will do this later).
- Branding text in pages + emails is now PYC 2027 / Abide / John 15:4 / June 2–6 / SMX
  Convention Center Davao, and the 2026 poster (`IMG_3908.jpeg`) was replaced by
  `img/worship.jpg` (pages, og:image, email banners, success-page share banner). Swap in a
  real 2027 poster when one exists.
- NOT changed (logic dates — developer to update): registration/accommodation close dates in
  `server-time.js`, `submit-registration.js`, closed-state messages ("ended on May 20/22,
  2026"), Mindanao dorm unlock date, 2026 early-bird dates in live register/payment.
  Because those 2026 close dates have passed, the OLD register/accommodations/tenting pages
  currently show their "closed" screens.
- `PYC_2026_Minor_Waiver.pdf` and the `PYC2026_RoomAssignments` Google Sheet name are still
  2026 — replace the PDF and rename references when ready.
- DONE: the 2027 landing page is now `public/index.html` (old one kept as
  `index-2026.html`; `/home-v2` redirects to `/`).
- "Check my status" page (self-service lookup) — top-bar link shows "coming soon" for now.
- Obtain `accommodation-login.js` (not in working copies) if accommodation login needs changes.
- Consider the QR check-in + meal redemption system for 2027 (§11 future).

---

## 17. DOCUMENTS IN THIS HANDOFF

| File | What it is |
|---|---|
| `CLAUDE.md` | This file — full project context (read first) |
| `register-v2-spec.md` | 2027 registration architecture: no-save-until-payment, compression, merged backend, groups, QR email |
| `register-v2-regfox-layout.md` | Build-ready RegFox-informed layout/theme spec for register-v2 (order, option cards, running total, group blocks, CSS, open questions) |
| `regfox-redesign-exploration.md` | The research report behind the layout spec (what RegFox pages really look like, what to adopt/skip) |
| `public/register-v2.html` | The 2027 wizard (all 3 steps + group flow + confirmation screen) |
| `add-reminder-sent-column.sql` | Required SQL before the reminder sender is used (recreated from the description in §15) |

---

## 18. RECENT CHANGE LOG (latest sessions)

Files changed, with what to verify is deployed (HTML → `public/`, JS → `netlify/functions/`):

- `admin-list-all.js`, `admin-stats.js` — paginated past the 1000-row cap (fixed people
  missing from export/list/counter/stats). `admin-stats.js` also now counts **Paid +
  Pending Review only** for every sub-stat and uses the correct age keys.
- `admin-dashboard.html` — GCash proofs tab account filter + "Paid to" on cards; account
  code→name labels; all approve/reject/export confirms moved to `adminConfirm` (iPad fix);
  Payments tab; export now async with count breakdown + "Meal & Shirt Totals" sheet; new
  "Export Check-In List" (name, shirt, phone, check-in status); stats age section reads
  `stats.ageGroups` with keys `0-8…36+` (fixed the `ageBrackets` crash).
- `md.html` — stats section rewritten to read the real backend fields (genders, locations,
  ageGroups, pycAttendance, mealPlans, tshirtSizes).
- `checkin.html` — theme matched to index.html (Bebas Neue, 3-stop gradient); meal plan
  shown for group members in all three group renders. Nothing else changed.
- `ac.html` (NEW, replaces `accommodation-checkin.html` — update links/QR/bookmarks) +
  `accommodation-checkin.js` (added `all_reservations` action). Room map, roommate lookup,
  admin-only Move, per-hall progress, free-beds filter, check-in-whole-room, straggler
  highlight. `CHECKIN_USERNAME` and `ADMIN_USERNAME` both get full access.
- `ar.html` — tent Excel export (Tents + Campers sheets) and the Import Assignments tab;
  `import-room-assignments.js` (NEW) — Google Sheet → `room_assignments`, merge, skip locked.
- `send-reminder.js` — rebuilt as a resumable batched sender (needs
  `add-reminder-sent-column.sql`). `auto-assign-rooms.js` — Pearl overfill and ghost-spot
  fixes (after deploying, Reset Assignments + re-run Auto-Assign; locked rooms preserved).
- `register-v2.html`, the three register-v2 docs above — 2027 redesign work (not live).
- **2027 build (this session):** `public/register-v2.html` (moved from repo root; `/register-v2`
  redirect), NEW `submit-registration-with-payment.js`, NEW `qr.js`, `email-helper.js`
  (QR block added to the approval/correction receipt — affects all approval emails),
  `package.json` (+`qrcode`), NEW `add-reminder-sent-column.sql`. Live `register.html`,
  `submit-registration.js`, `upload-payment-proof.js` untouched.

**Reminder:** several files above were edited from working copies that can lag the deployed
versions. Per §3.6, confirm the live version before editing any of them.
