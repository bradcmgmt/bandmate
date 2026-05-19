// Bandmate · Crew invite email (Vercel serverless function)
//
// Triggered when a TM adds a crew member on a tour. Sends a templated
// invite email via Resend. The link in the email lands the recipient
// on bandmate.art with ?invite=<tour_id>, which the front-end picks up
// to show a "you've been invited" banner during signup.
//
// Env vars required (set in Vercel → Project Settings → Environment Variables):
//   RESEND_API_KEY        (resend.com → API Keys)
//   INVITE_FROM_EMAIL     defaults to "Bandmate <noreply@bandmate.art>"
//   APP_BASE_URL          defaults to "https://bandmate.art"

const { Resend } = require('resend');

// Public function — no auth required. Anyone could in theory call this,
// but the payload they'd need to forge (tour name, crew name, TM name) is
// the same info they'd need to write the email themselves. We do basic
// rate-limit-friendly validation and reject obviously malformed input.
module.exports = async function handler(req, res) {
  // CORS — we call this from the same origin, so a same-origin browser
  // POST works without preflight, but leave the door open in case the
  // app moves to a separate subdomain later.
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.status(204).end(); return; }
  if (req.method !== 'POST') { res.status(405).json({ error: 'Method not allowed' }); return; }

  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    console.error('[crew-invite] RESEND_API_KEY not set');
    res.status(500).json({ error: 'Email service not configured' });
    return;
  }

  // Vercel parses JSON bodies for us by default — but be defensive in case
  // we ever flip that off or the client sends a malformed payload.
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { body = {}; }
  }
  body = body || {};

  const tourId = String(body.tourId || '').trim();
  const tourName = String(body.tourName || '').trim();
  const crewEmail = String(body.crewEmail || '').trim().toLowerCase();
  const crewName = String(body.crewName || '').trim();
  const crewRole = String(body.crewRole || '').trim();
  const tmName = String(body.tmName || '').trim();
  const tmEmail = String(body.tmEmail || '').trim().toLowerCase();
  const alreadyHasAccount = !!body.alreadyHasAccount;

  if (!crewEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(crewEmail)) {
    res.status(400).json({ error: 'Invalid recipient email' });
    return;
  }
  if (!tourName || !tmName) {
    res.status(400).json({ error: 'Missing required fields (tourName, tmName)' });
    return;
  }

  const fromEmail = process.env.INVITE_FROM_EMAIL || 'Bandmate <noreply@bandmate.art>';
  const baseUrl = (process.env.APP_BASE_URL || 'https://bandmate.art').replace(/\/$/, '');
  // The CTA target. Front-end reads ?invite=<tour_id> to render an
  // "you're being invited to <tour name>" banner on the signup form.
  // For users who already have an account, this just lands them on the
  // dashboard — they'll see the new tour as soon as they sign in.
  const inviteUrl = `${baseUrl}/?invite=${encodeURIComponent(tourId)}`;

  // Plain-text fallback (every transactional email should have one).
  const greeting = crewName ? `Hi ${crewName.split(/\s+/)[0]},` : 'Hi,';
  const roleLine = crewRole ? ` as ${crewRole}` : '';
  const ctaCopy = alreadyHasAccount
    ? `You can see this tour now in your Bandmate dashboard.`
    : `Bandmate is how your team stays in sync on the road — schedules, hotels, set lists, room assignments. To accept and see your tour, create your account:`;
  const ctaButton = alreadyHasAccount ? 'Open Bandmate' : 'Accept invite & set up your account';

  const text = [
    greeting,
    '',
    `${tmName} just added you to "${tourName}" on Bandmate${roleLine}.`,
    '',
    ctaCopy,
    inviteUrl,
    '',
    'Questions? Just reply to this email — it goes straight to ' + tmName + '.',
    '',
    '— The Bandmate team',
  ].join('\n');

  // Branded HTML version. Inline styles only — email clients strip <style> tags.
  const html = `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#0a0705;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;color:#e8d8c0">
  <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#0a0705">
    <tr><td align="center" style="padding:40px 20px">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="max-width:520px;background:#150e08;border:1px solid #2a1d10;border-radius:12px;overflow:hidden">
        <tr><td style="padding:32px 32px 24px;border-bottom:1px solid #2a1d10">
          <div style="font-family:'JetBrains Mono',Menlo,monospace;font-size:11px;letter-spacing:.22em;color:#e78f4f;text-transform:uppercase;font-weight:700;margin-bottom:6px">BANDMATE</div>
          <div style="font-size:13px;color:#a39280;letter-spacing:.04em">Tour management for the road</div>
        </td></tr>
        <tr><td style="padding:28px 32px">
          <div style="font-size:15px;line-height:1.6;color:#e8d8c0;margin-bottom:18px">${escapeHtml(greeting)}</div>
          <div style="font-size:15px;line-height:1.65;color:#e8d8c0;margin-bottom:22px">
            <b style="color:#fff">${escapeHtml(tmName)}</b> just added you to
            <b style="color:#e78f4f">"${escapeHtml(tourName)}"</b>
            on Bandmate${roleLine ? ` as <b style="color:#fff">${escapeHtml(crewRole)}</b>` : ''}.
          </div>
          <div style="font-size:14px;line-height:1.65;color:#a39280;margin-bottom:26px">${escapeHtml(ctaCopy)}</div>
          <div style="text-align:center;margin:0 0 26px">
            <a href="${escapeAttr(inviteUrl)}" style="display:inline-block;background:#e78f4f;color:#0a0705;text-decoration:none;padding:14px 24px;border-radius:9px;font-weight:700;font-size:14px;letter-spacing:.02em">${escapeHtml(ctaButton)} →</a>
          </div>
          <div style="font-size:12px;line-height:1.6;color:#7a6b58;border-top:1px solid #2a1d10;padding-top:18px;margin-top:6px">
            Questions? Just reply to this email — it goes straight to ${escapeHtml(tmName)}${tmEmail ? ` (${escapeHtml(tmEmail)})` : ''}.
          </div>
        </td></tr>
        <tr><td style="padding:18px 32px;background:#0d0906;border-top:1px solid #2a1d10">
          <div style="font-size:11px;color:#5a4e3f;text-align:center;letter-spacing:.04em">
            You're receiving this because ${escapeHtml(tmName)} added <b>${escapeHtml(crewEmail)}</b> to a tour roster on Bandmate.
          </div>
        </td></tr>
      </table>
      <div style="font-size:10.5px;color:#3d3528;margin-top:18px;letter-spacing:.06em">© Bandmate · bandmate.art</div>
    </td></tr>
  </table>
</body></html>`;

  const subject = alreadyHasAccount
    ? `${tmName} added you to "${tourName}" on Bandmate`
    : `${tmName} invited you to "${tourName}" on Bandmate`;

  const resend = new Resend(apiKey);
  try {
    const result = await resend.emails.send({
      from: fromEmail,
      to: [crewEmail],
      // Replies route to the TM, not the noreply box. Crew can ask the
      // person who actually invited them rather than emailing the void.
      reply_to: tmEmail || undefined,
      subject,
      html,
      text,
      // Resend tags for filtering in their dashboard
      tags: [
        { name: 'type', value: 'crew_invite' },
        { name: 'has_account', value: alreadyHasAccount ? 'yes' : 'no' },
      ],
    });
    if (result.error) {
      console.error('[crew-invite] resend error:', result.error);
      res.status(502).json({ error: result.error.message || 'Email send failed' });
      return;
    }
    console.log('[crew-invite] sent', crewEmail, '→', result.data?.id);
    res.status(200).json({ ok: true, id: result.data?.id });
  } catch (err) {
    console.error('[crew-invite] handler error:', err);
    res.status(500).json({ error: 'Send failed' });
  }
};

// Minimal HTML escapers — protects against tour names like
// "Best Tour <ever>" smuggling tags into our template.
function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
Move crew-invite into /api/
  
