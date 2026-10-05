# PYC 2027 — Registration Redesign Spec (register-v2)

A build plan for the new one-page wizard registration flow. Built fresh and parallel
to the current system; current `register.html` + `submit-registration.js` +
`upload-payment-proof.js` stay live and untouched until v2 is fully tested.

---

## The core principle

**Nothing is saved to the database until the attendee submits payment proof.**

The registration info is held in the browser through the whole flow and committed in a
SINGLE request at the end, together with the (compressed) payment screenshot. This
kills the duplicate / dead-record problem (people who registered, closed the tab, and
re-registered) because no row is ever created for someone who doesn't pay.

---

## The flow

```
STEP 1 — Your Information
  - All current form fields (see field list below)
  - On "Next": validated, held in browser memory (sessionStorage or a JS object)
  - NOTHING sent to the backend yet
        |
        v   (slides to next step, no page reload, nothing in DB)
STEP 2 — Payment
  - Shows: total amount due, the assigned GCash account (round-robin), reference note
  - "I've paid" advances to step 3
  - Still nothing in DB
        |
        v
STEP 3 — Upload Proof
  - Choose screenshot
  - Compress in browser (~1400px longest side, JPEG quality 0.8) -> ~500 KB
  - ONE request sends { all registration info + compressed image } together
  - Backend creates the record (status "Pending Review"), assigns PYC, sends email
        |
        v
  Done — "Payment under review" confirmation shown on screen
```

**Abandon at any step before upload = zero database impact.** Exactly the goal.

---

## Groups

Choice: everyone's info first, then one payment for the whole group.

```
STEP 1 — Add each member
  - Form for member 1, "[+ Add another member]" to add more
  - All members held in browser as a list (array of member objects)
STEP 2 — Payment
  - Shows total for the whole group + assigned GCash account
STEP 3 — Upload ONE proof for the group
  - ONE request: { array of all members + compressed image }
  - Backend creates all member rows at once, links by a shared group_id,
    assigns a PYC to each, sends one confirmation
```

No half-saved groups, no duplicates on re-do.

---

## Browser-side image compression (the key safety piece)

This is what makes the single combined request safe (info + image in one POST).

Settings chosen to keep GCash reference numbers / amounts READABLE:
- Resize so the **longest side is ~1400px** (resolution is what makes photos huge, not quality)
- **JPEG quality 0.8 (80%)** — text stays sharp; avoid 0.5-0.6 which blurs text
- **Only compress if the file is large** (e.g. > 800 KB); leave small screenshots alone
- Result: ~400-600 KB, every digit legible

Fallback if anything ever looks borderline: longest side 1600px, quality 0.85 (still a
huge reduction from a 4 MB phone photo).

Implementation: a `<canvas>` resize in the browser before upload. No library strictly
needed, though `browser-image-compression` (npm/CDN) is a clean ready-made option.

**Always eyeball a real compressed screenshot before shipping** to confirm readability.

---

## Backend change

Today (two steps):
- `submit-registration.js` creates the row (status "Pending")
- `upload-payment-proof.js` later adds image, flips to "Pending Review", assigns PYC

New (one step) — a new function, e.g. `submit-registration-with-payment.js`:
- Receives registration info (single or group array) + compressed image in one POST
- Inserts the row(s) directly as "Pending Review"
- Uploads the image to storage (same bucket as now)
- Assigns PYC number(s) — same logic that currently lives in upload-payment-proof.js
- Sends confirmation email
- For groups: insert all members, shared group_id, PYC each

Keep the CURRENT functions untouched and live. The new one is only used by
register-v2.html. Switch over only when v2 is proven.

---

## QR code (email-only, after approval)

- No QR on screen, no QR for unverified people.
- Record is created at proof-upload as "Pending Review".
- When admin APPROVES in the dashboard (status -> "Paid"), the approval email goes out
  WITH the QR code embedded (QR encodes the plain PYC number, e.g. "PYC-0487").
- QR generation: `qrcode` npm package in the approval/email function, embedded as an
  inline base64 image in the email HTML. No API key, no cost.

---

## Field list (carry over from current register.html)

Personal: firstName, lastName, email, confirmEmail, phone, gender, age, pycCount
Location: locationType (philippines / international)
  - PH regular: phRegion, phCity
  - PH VIP/full: vipStreet, vipBarangay, vipCity, vipProvince, vipRegion, vipZipCode
  - International: intCountry, intCity
Event: shirtSize, mealPlan (full / half)
Other: volunteer (+ volunteerRole), referralSource (+ otherSource), acceptTerms,
       minorWaiverAccept (required when age is 0-8 / 9-13 / 14-17)

Pricing: registration_fee (BASE_PRICE) + meal_fee (depends on mealPlan) = total_amount

Consider for v2 (reduce friction): move non-essential fields (referralSource,
otherSource) to AFTER confirmation or make optional, so they're not a barrier to
finishing. Every required field that isn't essential to attendance is a drop-off risk.

---

## Build order when ready

1. register-v2.html — wizard shell (3 steps, slide transitions, browser-held state)
2. Browser-side image compression (test readability on real screenshots)
3. submit-registration-with-payment.js — the merged single-commit backend
4. Group flow in the wizard
5. QR generation in the approval email (qrcode lib)
6. End-to-end test in parallel with live system
7. Switch register.html -> register-v2 only when fully verified

---

## What stays untouched until switchover

- register.html (current)
- submit-registration.js (current)
- upload-payment-proof.js (current)
- All dashboards, check-in pages, accommodation flow

The whole v2 build is additive and parallel. Zero risk to the running system.
