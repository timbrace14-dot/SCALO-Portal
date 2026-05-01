// Supabase Edge Function: scrape-reels
// Scrapes top 20 Instagram reels for a student and stores in Firebase.
//
// Auth model:
//   - Cron path: when called with the Supabase service-role key as Bearer (the way pg_cron
//     calls it), the function is allowed to scrape every student. Used for scheduled jobs.
//   - Student path: requires `idToken` (Firebase ID token) in the body. The function verifies
//     the token against Firebase and only scrapes the verified user's own UID. A 7-day per-user
//     cooldown is enforced via portal/social_profiles/{uid}/lastReelsScrapedAt to prevent abuse.
//
// Required env vars (Supabase Dashboard > Edge Functions > Secrets):
//   APIFY_API_TOKEN          — Apify API key
//   FIREBASE_DATABASE_URL    — e.g. https://scalo-client-portal-default-rtdb.firebaseio.com
//   FIREBASE_WEB_API_KEY     — Firebase Web API key (used to verify ID tokens)
//   SUPABASE_SERVICE_ROLE_KEY — auto-set by Supabase; used to detect cron callers

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

const COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

async function verifyFirebaseIdToken(idToken: string, apiKey: string): Promise<string> {
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  )
  if (!res.ok) throw new Error('Invalid auth token')
  const data = await res.json()
  const uid = data?.users?.[0]?.localId
  if (!uid) throw new Error('Invalid auth token')
  return uid
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN')
    if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not configured')

    const FB_URL = Deno.env.get('FIREBASE_DATABASE_URL') || 'https://scalo-client-portal-default-rtdb.firebaseio.com'
    const FB_API_KEY = Deno.env.get('FIREBASE_WEB_API_KEY')
    const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

    const authHeader = req.headers.get('Authorization') || ''
    const bearer = authHeader.replace(/^Bearer\s+/i, '').trim()
    const isCron = !!SERVICE_ROLE && bearer === SERVICE_ROLE

    const { uid: requestedUid, idToken } = await req.json().catch(() => ({} as any))

    // ── Resolve target UIDs and enforce auth ──
    let targetUids: string[] | null = null // null means "all eligible students"
    if (!isCron) {
      if (!FB_API_KEY) throw new Error('FIREBASE_WEB_API_KEY not configured')
      if (!idToken) return jsonResponse({ error: 'Authentication required' }, 401)
      const verifiedUid = await verifyFirebaseIdToken(idToken, FB_API_KEY)
      if (requestedUid && requestedUid !== verifiedUid) {
        return jsonResponse({ error: 'Cannot scrape another user' }, 403)
      }
      targetUids = [verifiedUid]

      // Per-user 7-day cooldown
      const lastRes = await fetch(`${FB_URL}/portal/social_profiles/${verifiedUid}/lastReelsScrapedAt.json`)
      const last = lastRes.ok ? await lastRes.json() : null
      if (typeof last === 'number' && Date.now() - last < COOLDOWN_MS) {
        const nextAt = last + COOLDOWN_MS
        const daysLeft = Math.ceil((nextAt - Date.now()) / 86400000)
        return jsonResponse({
          error: 'Cooldown',
          message: `You can refresh once a week. Try again in ${daysLeft} day${daysLeft === 1 ? '' : 's'}.`,
          nextAvailableAt: nextAt,
        }, 429)
      }
    }

    // Read all users and their social profiles from Firebase
    const [usersRes, profilesRes] = await Promise.all([
      fetch(`${FB_URL}/portal/users.json`),
      fetch(`${FB_URL}/portal/social_profiles.json`),
    ])
    const users = await usersRes.json()
    const profiles = await profilesRes.json()

    if (!users) throw new Error('No users found in Firebase')

    // Build list of students with Instagram handles
    const students: { uid: string; handle: string }[] = []
    for (const [fbUid, userData] of Object.entries(users as Record<string, any>)) {
      if (userData.role === 'admin' || userData.disabled) continue
      if (targetUids && !targetUids.includes(fbUid)) continue

      const profile = profiles?.[fbUid]
      if (!profile?.instagramUrl) continue

      const handle = profile.instagramUrl
        .replace(/https?:\/\/(www\.)?instagram\.com\//i, '')
        .replace(/[?#].*$/, '')
        .replace(/\//g, '')

      if (handle) students.push({ uid: fbUid, handle })
    }

    if (students.length === 0) {
      return jsonResponse({ message: 'No students with Instagram handles found' })
    }

    const results: any[] = []

    for (const student of students) {
      try {
        const runRes = await fetch(
          `https://api.apify.com/v2/acts/apify~instagram-reel-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: [student.handle],
              resultsLimit: 20,
            }),
          }
        )

        if (!runRes.ok) {
          const errText = await runRes.text()
          console.error(`Apify error for @${student.handle}:`, errText)
          results.push({ uid: student.uid, handle: student.handle, error: errText })
          continue
        }

        const reels = await runRes.json()
        const now = new Date().toISOString()

        const videos: Record<string, any> = {}
        for (const reel of reels.slice(0, 20)) {
          const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20)
          videos[id] = {
            caption: (reel.caption || '').slice(0, 500),
            views: reel.videoViewCount || reel.playCount || 0,
            plays: reel.videoPlayCount || reel.playCount || 0,
            likes: reel.likesCount || 0,
            comments: reel.commentsCount || 0,
            videoUrl: reel.url || reel.videoUrl || '',
            postedAt: reel.timestamp ? new Date(reel.timestamp).toISOString().slice(0, 10) : null,
            thumbnailUrl: reel.displayUrl || reel.thumbnailUrl || '',
            scrapedAt: now,
          }
        }

        const saveRes = await fetch(`${FB_URL}/portal/content_library/${student.uid}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(videos),
        })

        if (!saveRes.ok) {
          results.push({ uid: student.uid, handle: student.handle, error: `Firebase save failed: ${saveRes.status}` })
        } else {
          // Stamp the cooldown marker
          await fetch(`${FB_URL}/portal/social_profiles/${student.uid}/lastReelsScrapedAt.json`, {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(Date.now()),
          })
          results.push({ uid: student.uid, handle: student.handle, count: Object.keys(videos).length, scraped_at: now })
        }
      } catch (e) {
        results.push({ uid: student.uid, handle: student.handle, error: (e as Error).message })
      }
    }

    return jsonResponse({ success: true, results })
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500)
  }
})
