// Supabase Edge Function: send-inspo-email
// Sends a Monday morning email to users with their content inspo update.
// Triggered by pg_cron every Monday at 8:00 AM, or chained after scrape-inspo.
//
// Required env vars:
//   FIREBASE_DATABASE_URL
//   RESEND_API_KEY         — your Resend.com API key (or swap for SendGrid/Mailgun)
//   FROM_EMAIL             — e.g. hello@scalo.app

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function getWeekKey(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  d.setDate(d.getDate() + 3 - ((d.getDay() + 6) % 7))
  const jan4 = new Date(d.getFullYear(), 0, 4)
  const week = Math.ceil((((d.getTime() - jan4.getTime()) / 86400000) + jan4.getDay() + 1) / 7)
  return `${d.getFullYear()}_W${String(week).padStart(2, '0')}`
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const FB_URL = Deno.env.get('FIREBASE_DATABASE_URL')
    const RESEND_KEY = Deno.env.get('RESEND_API_KEY')
    const FROM_EMAIL = Deno.env.get('FROM_EMAIL') || 'SCALO <hello@scalo.app>'
    if (!FB_URL) throw new Error('FIREBASE_DATABASE_URL not configured')
    if (!RESEND_KEY) throw new Error('RESEND_API_KEY not configured')

    const weekKey = getWeekKey()

    // Get all users
    const usersRes = await fetch(`${FB_URL}/portal/users.json`)
    const users = await usersRes.json()
    if (!users) throw new Error('No users found')

    const results: any[] = []

    for (const [uid, user] of Object.entries(users as Record<string, any>)) {
      if (!user.email || user.role === 'admin') continue

      // Get this week's inspo videos for this user
      const inspoRes = await fetch(`${FB_URL}/portal/inspo_videos/${uid}/${weekKey}.json`)
      const inspoVideos = await inspoRes.json()

      // Get their creators
      const creatorsRes = await fetch(`${FB_URL}/portal/inspo_creators/${uid}.json`)
      const creators = await creatorsRes.json()

      if (!inspoVideos || Object.keys(inspoVideos).length === 0) {
        results.push({ uid, email: user.email, skipped: 'no inspo videos this week' })
        continue
      }

      // Group videos by creator
      const videosByCreator: Record<string, any[]> = {}
      for (const v of Object.values(inspoVideos)) {
        const vid = v as any
        if (!videosByCreator[vid.creatorHandle]) videosByCreator[vid.creatorHandle] = []
        videosByCreator[vid.creatorHandle].push(vid)
      }

      // Build email HTML
      const creatorSections = Object.entries(videosByCreator).map(([handle, vids]) => `
        <div style="margin-bottom:28px;">
          <div style="font-size:16px;font-weight:700;margin-bottom:12px;">@${handle}</div>
          ${(vids as any[]).map(v => `
            <div style="background:#1C1C1C;border-radius:10px;padding:14px;margin-bottom:10px;">
              <div style="font-size:14px;font-weight:600;color:#fff;margin-bottom:6px;">${(v.caption || 'Reel').slice(0, 80)}</div>
              <div style="font-size:12px;color:#999;margin-bottom:8px;">
                ${v.views ? v.views.toLocaleString() + ' views' : ''}
                ${v.likes ? ' &middot; ' + v.likes.toLocaleString() + ' likes' : ''}
              </div>
              ${v.link ? `<a href="${v.link}" style="color:#FF4533;font-size:13px;font-weight:700;text-decoration:none;">View Reel &rarr;</a>` : ''}
            </div>
          `).join('')}
        </div>
      `).join('')

      const emailHTML = `
        <!DOCTYPE html>
        <html><head><meta charset="UTF-8"></head>
        <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0A0A0A;color:#fff;padding:32px;max-width:600px;margin:0 auto;">
          <div style="margin-bottom:24px;">
            <div style="font-size:24px;font-weight:700;letter-spacing:-0.03em;">SCALO</div>
            <div style="font-size:13px;color:#999;margin-top:4px;">Your Weekly Content Inspo</div>
          </div>
          <div style="font-size:15px;color:rgba(255,255,255,0.85);margin-bottom:24px;line-height:1.5;">
            Hey ${user.firstName || 'there'}! Here are the top performing reels from the creators you follow this week.
          </div>
          ${creatorSections}
          <div style="margin-top:32px;padding-top:16px;border-top:1px solid rgba(255,255,255,0.12);font-size:12px;color:#666;">
            Sent from SCALO &middot; <a href="https://your-portal-url.com" style="color:#FF4533;">Open Portal</a>
          </div>
        </body></html>
      `

      // Send via Resend
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: FROM_EMAIL,
          to: user.email,
          subject: `Your Weekly Content Inspo — ${weekKey.replace('_', ' ')}`,
          html: emailHTML,
        }),
      })

      if (emailRes.ok) {
        results.push({ uid, email: user.email, sent: true })
      } else {
        const errText = await emailRes.text()
        results.push({ uid, email: user.email, error: errText })
      }
    }

    return new Response(JSON.stringify({ success: true, weekKey, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
