// Supabase Edge Function: scrape-profiles
// Scrapes Instagram & TikTok profile-level stats (followers, posts, views)
// for students and saves snapshots to Firebase.
//
// Auth model:
//   - Cron path: when called with the Supabase service-role key as Bearer (the way pg_cron
//     calls it), the function scrapes every student. Used for the daily scheduled job.
//   - Student path: requires `idToken` (Firebase ID token) in the body. The function verifies
//     the token against Firebase and only scrapes the verified user's own UID. A 7-day per-user
//     cooldown is enforced via portal/social_profiles/{uid}/lastProfilesScrapedAt.
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

function getWeekKey(): string {
  const now = new Date()
  const jan1 = new Date(now.getFullYear(), 0, 1)
  const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000)
  const week = Math.ceil((days + jan1.getDay() + 1) / 7)
  return `${now.getFullYear()}_W${String(week).padStart(2, '0')}`
}

async function firebaseGet(dbUrl: string, path: string) {
  const res = await fetch(`${dbUrl}/${path}.json`)
  if (!res.ok) return null
  return await res.json()
}

async function firebaseSet(dbUrl: string, path: string, data: any) {
  const res = await fetch(`${dbUrl}/${path}.json`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  })
  return res.ok
}

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

    let targetUids: string[] | null = null
    if (!isCron) {
      if (!FB_API_KEY) throw new Error('FIREBASE_WEB_API_KEY not configured')
      if (!idToken) return jsonResponse({ error: 'Authentication required' }, 401)
      const verifiedUid = await verifyFirebaseIdToken(idToken, FB_API_KEY)
      if (requestedUid && requestedUid !== verifiedUid) {
        return jsonResponse({ error: 'Cannot scrape another user' }, 403)
      }
      targetUids = [verifiedUid]

      const last = await firebaseGet(FB_URL, `portal/social_profiles/${verifiedUid}/lastProfilesScrapedAt`)
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

    const [users, profiles] = await Promise.all([
      firebaseGet(FB_URL, 'portal/users'),
      firebaseGet(FB_URL, 'portal/social_profiles'),
    ])

    if (!users) throw new Error('No users found in Firebase')

    const students: { uid: string; igHandle: string | null; tiktokUrl: string | null }[] = []
    for (const [fbUid, userData] of Object.entries(users as Record<string, any>)) {
      if (userData.role === 'admin' || userData.disabled) continue
      if (targetUids && !targetUids.includes(fbUid)) continue

      const profile = profiles?.[fbUid]
      if (!profile) continue

      let igHandle: string | null = null
      if (profile.instagramUrl) {
        igHandle = profile.instagramUrl
          .replace(/https?:\/\/(www\.)?instagram\.com\//i, '')
          .replace(/[?#].*$/, '')
          .replace(/\//g, '')
      }

      const tiktokUrl = profile.tiktokUrl || null

      if (igHandle || tiktokUrl) {
        students.push({ uid: fbUid, igHandle, tiktokUrl })
      }
    }

    if (students.length === 0) {
      return jsonResponse({ message: 'No students with social profiles found' })
    }

    const weekKey = getWeekKey()
    const results: any[] = []

    for (const student of students) {
      const snapshot: any = { scrapedAt: new Date().toISOString() }
      const prevData = await firebaseGet(FB_URL, `portal/social_history/${student.uid}/${weekKey}`)

      if (student.igHandle) {
        try {
          const runRes = await fetch(
            `https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ usernames: [student.igHandle] }),
            }
          )

          if (runRes.ok) {
            const profilesData = await runRes.json()
            if (profilesData && profilesData.length > 0) {
              const p = profilesData[0]
              snapshot.igFollowers = p.followersCount || p.followedByCount || 0
              snapshot.igPosts = p.postsCount || p.mediaCount || 0
              snapshot.igViews = p.profileViewsCount || 0

              const contentLib = await firebaseGet(FB_URL, `portal/content_library/${student.uid}`)
              if (contentLib) {
                const totalViews = Object.values(contentLib).reduce((sum: number, v: any) => sum + (v?.views || 0), 0)
                if (totalViews > 0) snapshot.igViews = totalViews
              }

              const prevFollowers = prevData?.igFollowers || 0
              snapshot.igNewFollowers = prevFollowers > 0 ? snapshot.igFollowers - prevFollowers : 0
            }
          } else {
            console.error(`Apify IG error for @${student.igHandle}:`, await runRes.text())
          }
        } catch (e) {
          console.error(`IG scrape failed for ${student.igHandle}:`, (e as Error).message)
        }
      }

      if (student.tiktokUrl) {
        try {
          const ttMatch = student.tiktokUrl.match(/@([\w.]+)/)
          const ttUsername = ttMatch ? ttMatch[1] : student.tiktokUrl
            .replace(/https?:\/\/(www\.)?tiktok\.com\/@?/i, '')
            .replace(/[?#].*$/, '')
            .replace(/\//g, '')

          if (ttUsername) {
            const runRes = await fetch(
              `https://api.apify.com/v2/acts/clockworks~tiktok-profile-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
              {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  profiles: [`https://www.tiktok.com/@${ttUsername}`],
                  resultsPerPage: 1,
                }),
              }
            )

            if (runRes.ok) {
              const profilesData = await runRes.json()
              if (profilesData && profilesData.length > 0) {
                const p = profilesData[0]
                snapshot.ttFollowers = p.authorMeta?.fans || p.fans || p.followerCount || 0
                snapshot.ttPosts = p.authorMeta?.video || p.videoCount || 0
                snapshot.ttViews = p.authorMeta?.heart || p.heartCount || p.totalLikes || 0

                const prevFollowers = prevData?.ttFollowers || 0
                snapshot.ttNewFollowers = prevFollowers > 0 ? snapshot.ttFollowers - prevFollowers : 0
              }
            } else {
              console.error(`Apify TT error for ${ttUsername}:`, await runRes.text())
            }
          }
        } catch (e) {
          console.error(`TT scrape failed for ${student.tiktokUrl}:`, (e as Error).message)
        }
      }

      const saved = await firebaseSet(FB_URL, `portal/social_history/${student.uid}/${weekKey}`, snapshot)
      if (saved) {
        await firebaseSet(FB_URL, `portal/social_profiles/${student.uid}/lastProfilesScrapedAt`, Date.now())
      }
      results.push({ uid: student.uid, weekKey, saved, snapshot })
    }

    return jsonResponse({ success: true, weekKey, results })
  } catch (err) {
    return jsonResponse({ error: (err as Error).message }, 500)
  }
})
