// Supabase Edge Function: notify-expiring-clients
// Sends a daily email to timbrace14@gmail.com listing clients whose programme
// ends within the next 30 days. Uses Gmail API with OAuth2 refresh token.
// Triggered by pg_cron daily at 8:00 AM UTC, or manually via HTTP.
//
// Required env vars (Supabase secrets):
//   FIREBASE_DATABASE_URL
//   GMAIL_CLIENT_ID
//   GMAIL_CLIENT_SECRET
//   GMAIL_REFRESH_TOKEN

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const ADMIN_EMAIL = 'timbrace14@gmail.com'

async function getGmailAccessToken(): Promise<string> {
  const clientId = Deno.env.get('GMAIL_CLIENT_ID')
  const clientSecret = Deno.env.get('GMAIL_CLIENT_SECRET')
  const refreshToken = Deno.env.get('GMAIL_REFRESH_TOKEN')
  if (!clientId || !clientSecret || !refreshToken) {
    throw new Error('Gmail OAuth credentials not configured (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)')
  }

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })

  const data = await res.json()
  if (!data.access_token) throw new Error('Failed to get Gmail access token: ' + JSON.stringify(data))
  return data.access_token
}

function buildMimeMessage(to: string, subject: string, body: string): string {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    '',
    body,
  ]
  // Gmail API expects URL-safe base64 encoded MIME message
  const raw = lines.join('\r\n')
  const encoded = btoa(unescape(encodeURIComponent(raw)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
  return encoded
}

async function sendGmailMessage(accessToken: string, to: string, subject: string, body: string) {
  const raw = buildMimeMessage(to, subject, body)
  const res = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ raw }),
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gmail send failed (${res.status}): ${err}`)
  }
  return await res.json()
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const FB_URL = Deno.env.get('FIREBASE_DATABASE_URL')
    if (!FB_URL) throw new Error('FIREBASE_DATABASE_URL not configured')

    // Fetch all users from Firebase
    const usersRes = await fetch(`${FB_URL}/portal/users.json`)
    const users = await usersRes.json()
    if (!users) throw new Error('No users found')

    const now = new Date()
    const expiringClients: { name: string; email: string; endDate: string; daysLeft: number }[] = []

    for (const [, user] of Object.entries(users as Record<string, any>)) {
      if (user.role !== 'client' || user.disabled) continue
      if (!user.programmeEnd) continue

      const endDate = new Date(user.programmeEnd)
      const daysLeft = Math.ceil((endDate.getTime() - now.getTime()) / 86400000)

      if (daysLeft >= 0 && daysLeft <= 30) {
        expiringClients.push({
          name: `${user.firstName || ''} ${user.lastName || ''}`.trim(),
          email: user.email || 'No email',
          endDate: user.programmeEnd,
          daysLeft,
        })
      }
    }

    if (expiringClients.length === 0) {
      return new Response(
        JSON.stringify({ ok: true, message: 'No clients expiring within 30 days' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      )
    }

    // Sort by days remaining (most urgent first)
    expiringClients.sort((a, b) => a.daysLeft - b.daysLeft)

    // Get Gmail access token
    const accessToken = await getGmailAccessToken()

    // Send one email per expiring client
    const results: any[] = []
    for (const client of expiringClients) {
      const subject = `SCALO Alert \u2014 ${client.name} is ending their programme in ${client.daysLeft} day${client.daysLeft !== 1 ? 's' : ''}`
      const body = [
        `Hi Tim,`,
        ``,
        `This is an automated reminder from SCALO.`,
        ``,
        `Student: ${client.name}`,
        `Email: ${client.email}`,
        `Programme End Date: ${new Date(client.endDate).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })}`,
        `Days Remaining: ${client.daysLeft}`,
        ``,
        client.daysLeft <= 7
          ? `This student's programme is ending THIS WEEK. Now would be a great time to reach out about continuing on a recurring basis.`
          : client.daysLeft <= 14
          ? `This student's programme is ending very soon. Consider reaching out to discuss renewal options.`
          : `This student has less than a month left. A good time to start the conversation about continuing.`,
        ``,
        `You can reach them at: ${client.email}`,
        ``,
        `\u2014 SCALO Notifications`,
      ].join('\n')

      try {
        await sendGmailMessage(accessToken, ADMIN_EMAIL, subject, body)
        results.push({ client: client.name, sent: true })
      } catch (err) {
        results.push({ client: client.name, sent: false, error: (err as Error).message })
      }
    }

    return new Response(
      JSON.stringify({ ok: true, expiring: expiringClients.length, results }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  } catch (err) {
    return new Response(
      JSON.stringify({ error: (err as Error).message }),
      { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    )
  }
})
