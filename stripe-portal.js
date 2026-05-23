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
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });
    res.status(200).json({ url: session.url });
  } catch (err) {
    console.error('[stripe-portal] portal create failed:', err);
    // Most common failure: portal isn't enabled in Stripe Dashboard yet.
    // Surface a friendly error so the user knows what to do.
    const msg = err.message || 'Portal create failed';
    res.status(502).json({
      error: msg,
      hint: /portal/i.test(msg)
        ? 'Enable the Customer Portal in Stripe Dashboard → Settings → Billing → Customer portal'
        : undefined,
    });
  }
};
