# Exploration Report: Redesigning PYC Registration in the RegFox Style

A review of how RegFox actually builds registration pages (based on their real live event
pages, not just marketing copy), what's genuinely worth borrowing, what to leave out, and
how it maps onto your existing register-v2 plan. **Nothing has been built — this is for
your review first.**

---

## 1. What I actually looked at

Marketing pages describe RegFox in generic terms ("stunning," "professional-grade"), so I
went further and pulled up several **live, real RegFox-hosted event pages** to see the
actual structure attendees experience — a corporate conference (RightNow Conference 2026),
a professional association event (IDABO Education Institute 2026), and a couple of others.
This report is based on what those pages are actually built like, not just RegFox's own
description of themselves.

---

## 2. The RegFox page structure, as it actually exists

Every RegFox page I examined follows the same skeleton, in this order:

1. **Header** — event name, banner image, sometimes sponsor logos in a row
2. **About/description section** — a few lines about the event, sometimes bullet highlights
3. **"Select an option" / Registration tiers** — ticket-type cards (e.g. "Team Pass —
   $425," "General Admission — $150"), each with a short description and price, chosen
   BEFORE any personal info is asked
4. **Add-ons** — optional extras shown as individual cards with an image, description,
   price, and an "Add" button (e.g. "Pre-Conference Workshop — $99," "Welcome Reception —
   FREE"). Free items use the same card pattern.
5. **Group/team registration** — an "Add Another Registrant" button that repeats the
   attendee-info block for each additional person, all under one purchase
6. **Coupon/discount code field** — a simple text input + "Apply" button, low-key, easy to skip
7. **Personal/billing information — LAST**, not first. Name, email, phone, address, payment
   details all come after the person has already committed to what they're buying
8. **Payment fields** — card number, expiry, billing address, inline on the same page
9. **Submit** — one button, no separate "next page"
10. **Footer** — "Event Registration Software by RegFox" branding

The single most important structural fact: **RegFox asks "what are you buying" before
"who are you."** Commitment (picking a ticket/add-ons) happens first; the friction of
filling out personal details comes only after someone has already decided to register.
This is a well-established conversion pattern — people who've already clicked "Team Pass"
are more invested and less likely to abandon during the info-collection part.

---

## 3. What's genuinely worth adapting for PYC

I'm separating this into **things that would clearly help you** vs. **things that look
nice but don't fit a Christian youth conference registration**, since not everything
RegFox does is right for your context.

### Worth adapting

**a) Reorder the flow: options/pricing first, personal info last.**
Right now your form asks for all personal details before conference options. Flipping
this — meal plan, t-shirt, accommodation add-on shown as clear priced cards up top, then
personal info at the bottom — makes the page feel like "I'm choosing what I want" rather
than "I'm filling out a bureaucratic form." This fits naturally into the register-v2
wizard we already planned; it just changes the *order* of Step 1's sections, not the
architecture.

**b) Treat meal plan / t-shirt / accommodation as visual "option cards," not a form field.**
Instead of a plain radio button list for meal plan, show it like RegFox's add-ons: a
card with a short description and the price attached, so the total updates as they pick
("Full Meal Plan — ₱1,500" / "Half Meal Plan — ₱900"). This makes pricing transparent
and feels more like a real purchase than filling out a survey.

**c) A running total that updates live as they choose options.**
RegFox always shows the current total before checkout. You already do this in the v2
payment-summary step — worth pulling it earlier so it's visible while they're still
picking options, not just at the end.

**d) "Add Another Registrant" pattern for groups.**
This matches exactly what we already decided for register-v2 — one flow, add each group
member, one total, one payment. RegFox's actual implementation validates that this is the
right shape for group registration.

**e) Confirmation page + emailed QR code, generated automatically.**
This is exactly the QR system we scoped out previously (§11 of your project plan) —
seeing it confirmed as RegFox's standard, default behavior (QR shown on the confirmation
page AND emailed, used by their own check-in app) validates that plan. No change needed
there; it's already the right design.

**f) Clean, minimal "option card" visual style.**
Simple bordered cards with a title, one line of description, and a price in the corner —
easy to scan, clearly separates "this costs money" from "this is free." Fits your navy/gold
theme well without needing RegFox's actual visual design (which is generic and not
branded to you).

### Not worth adapting

**a) RegFox's visual branding/theme itself.**
Their pages use RegFox's own generic light-theme styling (white backgrounds, blue
accents, plain sans-serif). That's not "professional" in some universal sense — it's just
their template. Your Bebas Neue + navy + gold theme is more distinctive and more "you."
Copying RegFox's visual look would make your page feel *less* branded, not more
professional. **Recommendation: adapt their structural pattern, keep your own visual
identity.**

**b) Coupon/discount codes.**
Not relevant — you don't run promo codes for a ministry conference.

**c) Card-on-file / "pay later" / installment payments.**
RegFox is built around live credit card processing. You use manual GCash/bank transfer
with proof upload, which is the right choice for your context (lower fees, works for your
audience, no card-processing compliance burden). Nothing to change here — this is a
deliberate difference, not a gap.

**d) Sponsor logo rows, "who's attending" social proof, upsells/merchandise.**
These are corporate-conference and revenue-maximization features. They don't fit a youth
ministry conference and would feel out of place / commercial.

**e) Their address/billing-heavy checkout (state dropdowns, full billing address for
every registrant).**
That's built for US-based credit card processing (billing address verification). Since
you're not processing cards live, you don't need this — your simpler PH-region /
international address fields are already appropriately scoped.

---

## 4. What this means for register-v2 specifically

Good news: **this doesn't conflict with the plan already in `register-v2-spec.md` — it
refines it.** Nothing about the "nothing saves until payment" architecture, the browser-held
state, the compression, or the merged backend needs to change. What this adds is guidance
on **how Step 1 is organized and presented**:

| Current register-v2 Step 1 order | RegFox-informed reordering |
|---|---|
| Location → Personal info → Address → Conference options (shirt/meal/pyc count) → Referral → Terms | Conference options (shirt/meal, shown as priced cards) → Location & Personal info → Address → Referral → Terms |

Practically: move the "what are you choosing" fields (meal plan, t-shirt, accommodation
if bundled in) to the **top** of Step 1, styled as option cards with prices, so the
running total in the Step 2 payment summary already feels earned by the time they get
there. Personal info (name/email/phone/address) moves to the second half of Step 1.

This is a **layout and ordering change within the existing wizard shell**, not a new
architecture — low risk, and it directly uses the wizard shell already built.

---

## 5. Suggested visual direction (not built yet)

A rough sketch of what a RegFox-informed but PYC-branded Step 1 could look like:

```
┌─────────────────────────────────────────┐
│  PYC 2027 REGISTRATION                   │  ← Bebas Neue, gold, your theme
│  Above and Beyond                        │
├─────────────────────────────────────────┤
│  CHOOSE YOUR OPTIONS                     │
│  ┌───────────────┐  ┌───────────────┐    │
│  │ Full Meal Plan│  │ Half Meal Plan│    │  ← option cards, price shown,
│  │ ₱1,500        │  │ ₱900          │    │     tap to select (like RegFox
│  └───────────────┘  └───────────────┘    │     add-on cards)
│  T-Shirt Size:  [ dropdown ]             │
│                                           │
│  Running total: ₱2,000            ←──────┼── updates live
├─────────────────────────────────────────┤
│  YOUR INFORMATION                        │  ← personal fields, now second
│  First Name [___]  Last Name [___]       │
│  ...                                     │
├─────────────────────────────────────────┤
│  [ Next: Payment → ]                     │
└─────────────────────────────────────────┘
```

---

## 6. My recommendation

Adopt the **structural reordering** (options-first, personal-info-second, visual option
cards, live running total) — it's a genuine, evidence-based improvement, low-risk since
it fits inside the wizard shell already built, and it's the part of RegFox that's actually
about good conversion design rather than generic template styling.

**Skip** copying RegFox's visual theme, coupon codes, live card processing, sponsor rows,
and billing-heavy checkout — none of that fits PYC or improves on what you already have
planned.

---

## 7. If you'd like to proceed

This was research only — nothing has been changed. If this direction looks right to you,
the next step would be reordering Step 1 of `register-v2.html` (already built) to put the
conference-options cards first and personal info second, plus restyling meal plan / shirt
size as priced option cards instead of a plain form. That's a contained update to the
existing wizard shell, not a rebuild.

Let me know which pieces from Section 3 you want to keep, drop, or adjust before anything
gets built.
