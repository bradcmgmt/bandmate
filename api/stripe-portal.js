// Bandmate · Stripe Customer Portal session (Vercel serverless function)
//
// Creates a short-lived portal session URL so the signed-in user can
// manage their own subscription (update card, view invoices, cancel,
// reactivate). All actions inside the portal fire Stripe webhooks
// against our /api/stripe-webhook, which keeps the local DB in sync.
//
// Caller flow:
//   POST /api/stripe-portal { supabaseAccessToken }
//   → { url: "https://billing.stripe.com/..." }
//   → window.location.assign(url)
//
// Env vars required (set in Vercel → Project Settings → Environment Variables):
//   STRIPE_SECRET_KEY         (Stripe Dashboard → Developers → API keys)
//   SUPABASE_URL              (your project URL)
//   SUPABASE_SERVICE_ROLE_KEY (Supabase → Settings → API → service_role — KEEP SECRET)
//
// The function authenticates the request by verifying the user's
// Supabase access token, then looks up their stripe_customer_id from
// the subscriptions table. No customer id = no subscription = no portal.

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const supaUrl = process.env.SUPABASE_URL;
  const supaServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!stripeKey || !supaUrl || !supaServiceKey) {
    console.error('[stripe-portal] missing env vars');
    res.status(500).json({ error: 'Server misconfigured' });
    return;
  }

  // Parse the request body
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};

  const accessToken = (body.supabaseAccessToken || '').toString();
  const returnUrl = (body.returnUrl || 'https://bandmate.art').toString();
  if (!accessToken) { res.status(400).json({ error: 'Missing supabaseAccessToken' }); return; }

  // Verify the token by fetching the user via Supabase admin
  const supa = createClient(supaUrl, supaServiceKey, { auth: { persistSession: false } });
  let userId = null;
  let userEmail = null;
  try {
    const { data, error } = await supa.auth.getUser(accessToken);
    if (error || !data?.user) {
      console.warn('[stripe-portal] getUser failed:', error?.message);
      res.status(401).json({ error: 'Invalid session' });
      return;
    }
    userId = data.user.id;
    userEmail = (data.user.email || '').toLowerCase();
  } catch (e) {
    console.error('[stripe-portal] getUser threw:', e);
    res.status(401).json({ error: 'Could not verify session' });
    return;
  }

  // Look up the user's Stripe customer ID from the subscriptions table.
  // Try user_id first (the modern signup-first link), fall back to email
  // (legacy pay-first link where user_id may be null).
  let customerId = null;
  try {
    const { data: byId } = await supa
      .from('subscriptions')
      .select('stripe_customer_id')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (byId?.stripe_customer_id) customerId = byId.stripe_customer_id;
    if (!customerId && userEmail) {
      const { data: byEmail } = await supa
        .from('subscriptions')
        .select('stripe_customer_id')
        .ilike('email', userEmail)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (byEmail?.stripe_customer_id) customerId = byEmail.stripe_customer_id;
    }
  } catch (e) {
    console.error('[stripe-portal] subscription lookup threw:', e);
  }

  if (!customerId) {
    console.warn('[stripe-portal] no stripe_customer_id for user', userId, userEmail);
    res.status(404).json({ error: 'No subscription found for this account. Subscribe first.' });
    return;
  }

  // Create the portal session
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-09-30.acacia' });
  // Wrap in a self-healing loop: if Stripe returns "No such customer"
  // for the ID we have on file, the row is stale (customer was deleted
  // or merged in Stripe — common when a user accidentally created two
  // checkout sessions early on). Look up the customer by email in
  // Stripe directly, pick the one with an active subscription, persist
  // the fix to the subscriptions table, and retry.
  async function openPortal(cid) {
    return stripe.billingPortal.sessions.create({
      customer: cid,
      return_url: returnUrl,
    });
  }
  try {
    const session = await openPortal(customerId);
    res.status(200).json({ url: session.url });
    return;
  } catch (err) {
    const isMissing = err && (err.code === 'resource_missing'
      || /No such customer/i.test(err.message || ''));
    if (!isMissing) {
      console.error('[stripe-portal] portal create failed:', err);
      const msg = err.message || 'Portal create failed';
      res.status(502).json({
        error: msg,
        hint: /portal/i.test(msg)
          ? 'Enable the Customer Portal in Stripe Dashboard → Settings → Billing → Customer portal'
          : undefined,
      });
      return;
    }
    // Stale customer ID — try to recover. Search Stripe by email and
    // pick the customer that actually has a subscription attached.
    console.warn('[stripe-portal] stale customer id, attempting recovery for', userEmail);
    if (!userEmail) {
      res.status(404).json({ error: 'Your subscription record is out of sync. Contact support to reset it.' });
      return;
    }
    try {
      const found = await stripe.customers.list({ email: userEmail, limit: 10 });
      let healed = null;
      // Prefer a customer with an active subscription. If none have
      // active subs, fall back to the most recently created one.
      for (const c of found.data) {
        const subs = await stripe.subscriptions.list({ customer: c.id, status: 'all', limit: 5 });
        const hasLive = subs.data.some(s => ['active','trialing','past_due'].includes(s.status));
        if (hasLive) { healed = c; break; }
      }
      if (!healed && found.data.length) {
        healed = found.data.sort((a, b) => (b.created || 0) - (a.created || 0))[0];
      }
      if (!healed) {
        res.status(404).json({ error: 'No Stripe customer found for this email. Subscribe first to set up billing.' });
        return;
      }
      // Persist the healed id so future calls (and the webhook) skip
      // this recovery path. Update by user_id first, then email as
      // fallback for legacy pay-first rows.
      try {
        const upd1 = await supa
          .from('subscriptions')
          .update({ stripe_customer_id: healed.id })
          .eq('user_id', userId);
        if (!upd1.count) {
          await supa
            .from('subscriptions')
            .update({ stripe_customer_id: healed.id })
            .ilike('email', userEmail);
        }
        console.log('[stripe-portal] healed customer id', { old: customerId, new: healed.id, user: userId });
      } catch (e) {
        console.warn('[stripe-portal] heal-write failed:', e?.message);
        // Continue anyway — opening the portal with the right id is
        // more important than persisting the fix this round.
      }
      const session = await openPortal(healed.id);
      res.status(200).json({ url: session.url });
    } catch (e2) {
      console.error('[stripe-portal] recovery failed:', e2);
      res.status(502).json({
        error: 'Could not open billing portal. Your account may have multiple Stripe customers — contact support.',
      });
    }
  }
};
