# register-v2 — RegFox-Informed Layout & Theme Spec

Companion to `register-v2-spec.md` (architecture) and `regfox-redesign-exploration.md`
(research). This file is the **build-ready design spec** for the 2027 registration page:
what the page looks like, in what order, and how each component behaves.

**Status:** Direction chosen by the developer for inclusion in the handoff. The individual
items below have not each been reviewed one-by-one, so treat the "Open questions" in §9 as
things to confirm before building. Nothing here has been built yet. The existing
`register-v2.html` wizard shell (Step 1 form in the OLD field order, Steps 2–3 as stubs)
is the starting point.

---

## 1. Design principle

**Borrow RegFox's structure. Keep PYC's identity.**

- Structure to copy: the order of the page, the option-card pattern, the live running
  total, the "Add Another Registrant" group pattern, QR on confirmation.
- Identity to keep: Bebas Neue / Montserrat, navy + gold, the 3-stop navy gradient.
  RegFox's own visual style is a generic white/blue template, so copying it would make the
  page look less branded, not more professional.
- Not copied: coupon codes, live card checkout, billing-address blocks, sponsor rows,
  upsells/merch. None fit a ministry event paid by GCash/bank transfer.

---

## 2. What RegFox actually does (evidence, from live event pages)

Observed on real RegFox-hosted pages (RightNow Conference 2026, IDABO Education
Institute 2026, others):

1. Header: event name + banner image (sometimes sponsor logos)
2. About / description section
3. Registration tier selection as cards with price (e.g. "Team Pass ($425.00)")
4. Add-ons as cards: image, title, description, price ("$35.00 ea."), an **Add** button;
   free items use the same card with "$0.00 ea."
5. "Add Another Registrant" button for group/team purchases
6. Coupon code field + Apply
7. "Almost done. Where should we send the confirmation?" — email, name, phone **last**
8. Payment fields
9. One Submit button (no separate page)
10. Sticky top nav with help links: Register, Resend Confirmation, Login, Contact
11. After submit: confirmation page + emailed QR code, which their check-in app scans

Key pattern: **"what are you buying" comes before "who are you."**

---

## 3. New page skeleton for PYC (single page, 3 wizard steps)

The wizard (Info → Payment → Upload Proof) and the "nothing saved until proof is
submitted" rule from `register-v2-spec.md` are unchanged. Only the **order inside Step 1**
and the **visual treatment** change.

```
[ Sticky top bar ]  PYC 2027 · Register · Check my status · Contact

[ Header ]          PYC 2027 REGISTRATION  (Bebas Neue, gold)
                    Above and Beyond · dates · venue (one line)

[ Progress ]        1 Info  —  2 Payment  —  3 Upload Proof

STEP 1
  A. CHOOSE YOUR OPTIONS
       Meal plan        -> two option cards (price on card)
       T-shirt size     -> dropdown (or size chips)
       [ Running total bar — sticky, updates live ]
  B. WHO IS ATTENDING
       Location type, name, age, gender, minor waiver (if under 18)
  C. CONTACT
       Email, confirm email, phone
  D. ADDRESS (conditional PH / International)
  E. A FEW MORE QUESTIONS
       PYC count, volunteer, referral source
  F. TERMS  (checkbox) 
  G. [ + Add another registrant ]   <- group flow
  H. [ Next: Payment -> ]

STEP 2  Payment summary (per-person lines + total) + assigned GCash/bank details
STEP 3  Upload proof (compressed in browser) -> single combined submit
DONE    Confirmation screen: "Payment under review" + what happens next
```

All current fields remain **required** (developer decision). Gender is validated
explicitly in JS (known bug in live register.html: `required` only on the Male radio).

---

## 4. Components

### 4.1 Option card (meal plan)
Radio-backed card, whole card tappable, min 56px tall.

```html
<label class="opt-card" for="mealFull">
  <input type="radio" id="mealFull" name="mealPlan" value="full" data-price="1500">
  <div class="opt-body">
    <div class="opt-title">Full Meal Plan</div>
    <div class="opt-desc">All conference meals included</div>
  </div>
  <div class="opt-price">₱1,500</div>
</label>
```
```css
.opt-card{display:flex;align-items:center;gap:14px;padding:16px;border-radius:12px;
  background:rgba(255,255,255,.04);border:1.5px solid rgba(212,165,86,.25);cursor:pointer;
  min-height:56px;transition:border-color .15s,background .15s}
.opt-card input{position:absolute;opacity:0;pointer-events:none}
.opt-card:has(input:checked){border-color:#d4a556;background:rgba(212,165,86,.12)}
.opt-title{font-weight:600}
.opt-desc{font-size:.8rem;color:rgba(245,245,245,.6)}
.opt-price{margin-left:auto;font-weight:700;color:#d4a556;white-space:nowrap}
```
`:has()` is fine on current iOS Safari; add a JS class toggle fallback if testing on older
iPads shows it missing. Validation error ("Please select a meal plan") shows under the card
group, same pattern as the other fields.

### 4.2 Running total bar
Sticky at the bottom of the viewport on Step 1 (above the Next button area on mobile).
Shows: `Total: ₱2,000` and, for groups, `3 registrants`. Updates on every option change via
one `recalcTotal()` function that reads the data-price attributes. The same function feeds
the Step 2 summary so numbers can never disagree.

### 4.3 Group: "Add another registrant"
- Each registrant is a collapsible block; Step 1 holds an **array** `registrants[]` in the
  browser (not a single `formData`).
- Shared across the group: contact email (primary's), payment. Per person: name, age,
  gender, shirt, meal, etc.
- Remove button on every block except the first.
- Total = sum of each person's options.
- Single commit at proof upload creates all rows with one shared `group_id`
  (see `register-v2-spec.md`).

### 4.4 Sticky top bar (optional, low priority)
RegFox shows help links. For PYC: "Register", "Check my status" (future self-service
status page), "Contact" (FB/IG links already used in emails). Skip "Login" and "Resend
confirmation" until a status page exists.

### 4.5 Confirmation screen (after final submit)
Plain, calm: check icon, "Payment under review", the person's name, what happens next
(approval email with QR code once verified), contact route. **No QR on screen** — the QR
is emailed only after an admin approves (developer decision), unlike RegFox which shows it
immediately. Do not show a PYC number until one is assigned.

---

## 5. Theme tokens (unchanged from the site)

```css
:root{--primary-navy:#1a2332;--secondary-gold:#d4a556;--light:#f5f5f5}
body{font-family:'Montserrat',sans-serif;
  background:linear-gradient(135deg,#0f1419 0%,#1a2332 50%,#2a3f5f 100%);
  background-attachment:fixed;color:#f5f5f5}
h1,h2,.section-header{font-family:'Bebas Neue',sans-serif;letter-spacing:1–2px;color:#d4a556}
```
Inputs: 16px font (prevents iOS zoom), ≥50px tall. Typography note: the developer's stated
convention lists Cormorant Garamond for input fields, while the current register-v2 shell
uses Montserrat for inputs. Confirm which to use (see §9).

---

## 6. Mobile rules (most registrants are on phones)

- Single column; option cards stack full width under ~480px
- Tap targets ≥ 44–54px; sticky total bar must not cover the Next button or fields
- No horizontal scroll; `viewport` meta with `width=device-width, initial-scale=1`
- Scroll to first invalid field on a failed Next (already in the shell)
- Custom modals only — never native `confirm()`/`alert()` (iPad Safari silently fails).
  The shell's Step 3 placeholder currently calls `alert()`; **replace it** when wiring submit.

---

## 7. Implementation notes for register-v2.html

1. Reorder the Step 1 sections to the order in §3; **do not change field names/ids or
   validation rules**, so `captureStep1()`/`validateStep1()` keep working.
2. Replace the meal-plan radio group with option cards (§4.1); keep `name="mealPlan"` and
   values `full` / `half`.
3. Add `recalcTotal()` and the sticky total bar (§4.2); reuse it in `updatePaymentSummary()`.
4. Convert `formData` to `registrants[]` when adding the group flow (§4.3).
5. Keep **zero `fetch` calls** until the final upload step.
6. Do not touch live `register.html`, `submit-registration.js`, or
   `upload-payment-proof.js` until v2 is proven end to end.
7. Prefer data attributes + a handler wrapper over inline `onclick` with JSON/escaped
   strings (breaks on special characters, e.g. apostrophes in names).

---

## 8. Build order (updated)

1. ✅ Wizard shell (old field order) — done
2. **Reorder Step 1 + option cards + running total** (this spec)
3. Browser-side image compression (~1400px, JPEG 0.8, only if >800KB; fallback 1600/0.85)
4. `submit-registration-with-payment.js` (merged single-commit backend)
5. Group flow (`registrants[]`, Add another registrant)
6. QR in the approval email (`qrcode` npm, plain PYC number, inline base64)
7. End-to-end test alongside the live system
8. Switch over only when verified

---

## 9. Open questions to confirm with the developer before building

1. **Meal options & prices.** Shell uses placeholder `{base:500, full:1500, half:900}`.
   March 2026 history lists "with meals / without meals" tiers (early bird 1750/750,
   regular 1850/850). Is there a "no meal" option for 2027? What are the real prices?
   This decides how many meal cards exist.
2. **Is accommodation/tenting bundled into registration?** Currently separate pages
   (`accommodations.html`, `tenting.html`). Default assumption: keep them separate.
3. **Input font:** Montserrat (current shell) or Cormorant Garamond (developer convention)?
4. **Sticky top bar / "Check my status":** include now, or wait until a status page exists?
5. **Early-bird vs regular pricing:** is date-based pricing wanted again in 2027? If so the
   running total must read the active tier (use the server's time, see `server-time.js`).
