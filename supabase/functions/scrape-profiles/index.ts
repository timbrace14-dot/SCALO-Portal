// Supabase Edge Function: scrape-profiles
// Scrapes Instagram & TikTok profile-level stats (followers, posts, views)
// for all students and saves daily snapshots to Firebase.
// Reads student handles from Firebase (not Supabase).
// Triggered daily via pg_cron at 6:00 AM UTC.
//
// Required env vars (set in Supabase Dashboard > Edge Functions > Secrets):
//   APIFY_API_TOKEN         — your Apify API key
//   FIREBASE_DATABASE_URL   — e.g. https://scalo-client-portal-default-rtdb.firebaseio.com

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Get current week key (matches portal format: YYYY_WXX)
function getWeekKey(): string {
  const now = new Date()
  const jan1 = new Date(now.getFullYear(), 0, 1)
  const days = Math.floor((now.getTime() - jan1.getTime()) / 86400000)
  const week = Math.ceil((days + jan1.getDay() + 1) / 7)
  return `${now.getFullYear()}_W${String(week).padStart(2, '0')}`
}

// Firebase REST helpers
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

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN')
    if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not configured')

    const FB_URL = Deno.env.get('FIREBASE_DATABASE_URL') || 'https://scalo-client-portal-default-rtdb.firebaseio.com'

    // Optional: target a specific user
    const { uid: targetUid } = await req.json().catch(() => ({}))

    // Read all users and their social profiles from Firebase
    const [users, profiles] = await Promise.all([
      firebaseGet(FB_URL, 'portal/users'),
      firebaseGet(FB_URL, 'portal/social_profiles'),
    ])

    if (!users) throw new Error('No users found in Firebase')

    // Build list of students with social profiles
    const students: { uid: string; igHandle: string | null; tiktokUrl: string | null }[] = []
    for (const [fbUid, userData] of Object.entries(users as Record<string, any>)) {
      if (userData.role === 'admin' || userData.disabled) continue
      if (targetUid && fbUid !== targetUid) continue

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
      return new Response(JSON.stringify({ message: 'No students with social profiles found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const weekKey = getWeekKey()
    const results: any[] = []

    for (const student of students) {
      const snapshot: any = { scrapedAt: new Date().toISOString() }

      // Get previous data to calculate new followers
      const prevData = await firebaseGet(FB_URL, `portal/social_history/${student.uid}/${weekKey}`)

      // ── INSTAGRAM ──
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

              // Also get total views from content library if available
              const contentLib = await firebaseGet(FB_URL, `portal/content_library/${student.uid}`)
              if (contentLib) {
                const totalViews = Object.values(contentLib).reduce((sum: number, v: any) => sum + (v?.views || 0), 0)
                if (totalViews > 0) snapshot.igViews = totalViews
              }

              // Calculate new followers
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

      // ── TIKTOK ──
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

                // Calculate new followers
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

      // Save to Firebase (overwrite current week with latest data)
      const saved = await firebaseSet(FB_URL, `portal/social_history/${student.uid}/${weekKey}`, snapshot)
      results.push({ uid: student.uid, weekKey, saved, snapshot })
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
