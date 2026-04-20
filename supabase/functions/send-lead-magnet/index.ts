// Supabase Edge Function: send-lead-magnet
// Sends a branded email with a link to the free resource.
// Called from the lead magnet landing page when a user submits their email.
//
// Required env vars (already set from existing SCALO functions):
//   RESEND_API_KEY   — your Resend.com API key
//   FROM_EMAIL       — e.g. SCALO <hello@scalo.app>

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const RESEND_KEY = Deno.env.get('RESEND_API_KEY')
    const FROM_EMAIL = 'Tim <tim@usescalo.com>'
    if (!RESEND_KEY) throw new Error('RESEND_API_KEY not configured')

    const { email, leadMagnetName, resourceUrl } = await req.json()

    if (!email || !email.includes('@') || !email.includes('.')) {
      return new Response(
        JSON.stringify({ success: false, error: 'Please enter a valid email address.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    if (!leadMagnetName || !resourceUrl) {
      return new Response(
        JSON.stringify({ success: false, error: 'Missing resource configuration.' }),
        { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    const emailHTML = `
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"></head>
      <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Helvetica Neue',sans-serif;background:#0A0A0A;color:#fff;padding:0;margin:0;">
        <div style="max-width:600px;margin:0 auto;padding:40px 32px;">

          <!-- Header -->
          <div style="margin-bottom:32px;">
            <div style="font-size:24px;font-weight:800;letter-spacing:-0.03em;color:#fff;">SCALO</div>
          </div>

          <!-- Greeting -->
          <div style="font-size:18px;font-weight:700;color:#fff;margin-bottom:12px;">
            Your free resource is here.
          </div>

          <div style="font-size:15px;color:rgba(255,255,255,0.7);line-height:1.6;margin-bottom:28px;">
            Thanks for claiming <strong style="color:#fff;">${leadMagnetName}</strong>. Click the button below to access it right now.
          </div>

          <!-- CTA Button -->
          <div style="margin-bottom:32px;">
            <a href="${resourceUrl}" style="display:inline-block;padding:16px 32px;background:#B8E986;color:#000;font-size:14px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;text-decoration:none;border-radius:6px;">
              Access Your Free Resource
            </a>
          </div>

          <!-- Note -->
          <div style="font-size:13px;color:rgba(255,255,255,0.4);line-height:1.5;margin-bottom:32px;">
            If the button doesn't work, copy and paste this link into your browser:<br>
            <a href="${resourceUrl}" style="color:#B8E986;word-break:break-all;">${resourceUrl}</a>
          </div>

          <!-- Footer -->
          <div style="padding-top:24px;border-top:1px solid rgba(255,255,255,0.08);font-size:12px;color:rgba(255,255,255,0.3);">
            Sent from SCALO
          </div>

        </div>
      </body></html>
    `

    const emailRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${RESEND_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: FROM_EMAIL,
        to: email,
        subject: `Your Free Resource: ${leadMagnetName}`,
        html: emailHTML,
      }),
    })

    if (emailRes.ok) {
      return new Response(
        JSON.stringify({ success: true }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    } else {
      const errText = await emailRes.text()
      console.error('Resend error:', errText)

      let parsed: any = {}
      try { parsed = JSON.parse(errText) } catch {}

      // Check for invalid email specifically
      if (parsed?.name === 'validation_error' && errText.includes('to')) {
        return new Response(
          JSON.stringify({ success: false, error: 'That email address appears to be invalid. Please check and try again.' }),
          { status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
        )
      }

      return new Response(
        JSON.stringify({ success: false, error: 'Failed to send email. Please try again.', detail: parsed?.message || errText }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }
  } catch (err) {
    console.error('Edge function error:', (err as Error).message)
    return new Response(
      JSON.stringify({ success: false, error: 'Something went wrong. Please try again.' }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
