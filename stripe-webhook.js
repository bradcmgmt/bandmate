// Bandmate · Stripe webhook receiver (Vercel serverless function)
//
// Stripe POSTs subscription lifecycle events here. We verify the signature
// using STRIPE_WEBHOOK_SECRET, then upsert the row in public.subscriptions
// via the Supabase service-role key (which bypasses RLS).
//
// Env vars required (set in Vercel → Project Settings → Environment Variables):
//   STRIPE_SECRET_KEY              (Stripe Dashboard → Developers → API keys)
//   STRIPE_WEBHOOK_SECRET          (Stripe Dashboard → Developers → Webhooks → your endpoint → Signing secret)
//   SUPABASE_URL                   (already known: https://xyzmxzawqmjsccxecmts.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY      (Supabase → Project Settings → API → service_role secret — KEEP SECRET)

const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

// Disable Vercel's default body parser — Stripe signature verification needs
// the raw request body byte-for-byte.
module.exports.config = { api: { bodyParser: false } };

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks);
}

function toIso(unixSeconds) {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString();
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') { res.status(405).send('Method not allowed'); return; }

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const supaUrl = process.env.SUPABASE_URL;
  const supaKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!stripeKey || !webhookSecret || !supaUrl || !supaKey) {
    res.status(500).send('Server misconfigured — missing env vars');
    return;
  }
  const stripe = new Stripe(stripeKey, { apiVersion: '2024-09-30.acacia' });
  const supa = createClient(supaUrl, supaKey, { auth: { persistSession: false } });

  const rawBody = await readRawBody(req);
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(rawBody, sig, webhookSecret);
  } catch (err) {
    console.warn('[stripe-webhook] bad signature:', err.message);
    res.status(400).send(`Webhook signature error: ${err.message}`);
    return;
  }

  // Resolve a subscription record from any of the lifecycle events we listen to.
  async function upsertFromSubscription(sub, fallbackEmail) {
    const email = (sub.customer_email
      || fallbackEmail
      || (sub.customer && typeof sub.customer === 'object' ? sub.customer.email : null)
      || '').toLowerCase();
    if (!email && !sub.id) {
      console.warn('[stripe-webhook] no email or subscription id, skipping');
      return;
    }
    const row = {
      email,
      stripe_customer_id: typeof sub.customer === 'string' ? sub.customer : sub.customer?.id,
      stripe_subscription_id: sub.id,
      plan: 'standard',
      status: sub.status,
      current_period_end: toIso(sub.current_period_end),
      trial_end: toIso(sub.trial_end),
      cancel_at_period_end: !!sub.cancel_at_period_end,
    };
    // Look up an existing user_id by email so the row links back to the user
    // if they've already signed up.
    if (email) {
      const { data: profile } = await supa
        .from('profiles')
        .select('id')
        .eq('email', email)
        .maybeSingle();
      if (profile?.id) row.user_id = profile.id;
    }
    const { error } = await supa
      .from('subscriptions')
      .upsert(row, { onConflict: 'stripe_subscription_id' });
    if (error) console.error('[stripe-webhook] upsert failed:', error);
    else console.log('[stripe-webhook] upserted', email, sub.status);
  }

  try {
    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object;
        // checkout.session.completed has a subscription id (when mode=subscription)
        // but not the full subscription object. Pull it.
        if (session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          await upsertFromSubscription(sub, session.customer_details?.email || session.customer_email);
        }
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted':
      case 'customer.subscription.trial_will_end': {
        const sub = event.data.object;
        // Stripe sometimes only sends the customer id, not the email. Fetch
        // the customer if needed to resolve the email.
        let email = null;
        if (typeof sub.customer === 'string') {
          try {
            const cust = await stripe.customers.retrieve(sub.customer);
            email = cust && !cust.deleted ? cust.email : null;
          } catch (e) { /* non-fatal */ }
        }
        await upsertFromSubscription(sub, email);
        break;
      }
      case 'invoice.payment_failed': {
        const inv = event.data.object;
        if (inv.subscription) {
          const sub = await stripe.subscriptions.retrieve(inv.subscription);
          await upsertFromSubscription(sub, inv.customer_email);
        }
        break;
      }
      default:
        // Other events ignored; respond OK so Stripe doesn't retry.
        console.log('[stripe-webhook] ignored event', event.type);
    }
  } catch (err) {
    console.error('[stripe-webhook] handler error:', err);
    res.status(500).send('Handler error');
    return;
  }

  res.status(200).json({ received: true });
};
