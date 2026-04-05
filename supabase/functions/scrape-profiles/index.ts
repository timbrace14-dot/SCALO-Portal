// Supabase Edge Function: scrape-profiles
// Scrapes Instagram & TikTok profile-level stats (followers, posts, views)
// for all students and saves daily snapshots to Firebase.
// Triggered daily via pg_cron at 6:00 AM UTC.
//
// Required env vars (set in Supabase Dashboard > Edge Functions > Secrets):
//   APIFY_API_TOKEN         — your Apify API key
//   FIREBASE_DATABASE_URL   — e.g. https://scalo-client-portal-default-rtdb.firebaseio.com
//   SUPABASE_URL            — auto-provided
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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

// Firebase REST helper
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

    const FIREBASE_DB_URL = Deno.env.get('FIREBASE_DATABASE_URL') || 'https://scalo-client-portal-default-rtdb.firebaseio.com'

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Get all students — try with tiktok_url, fall back without it
    let res = await supabase.from('students').select('id, instagram_handle, tiktok_url')
    if (res.error && res.error.message.includes('tiktok_url')) {
      res = await supabase.from('students').select('id, instagram_handle')
      if (res.data) res.data = res.data.map((s: any) => ({ ...s, tiktok_url: null }))
    }
    const students = res.data
    const studentsErr = res.error

    if (studentsErr) throw studentsErr
    if (!students || students.length === 0) {
      return new Response(JSON.stringify({ message: 'No students found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Build mapping: Supabase student ID -> Firebase UID
    // Match by supabaseStudentId field or by email
    const fbUsersRes = await fetch(`${FIREBASE_DB_URL}/portal/users.json`)
    const fbUsers = fbUsersRes.ok ? await fbUsersRes.json() : {}
    const supaToFirebase: Record<string, string> = {}

    // Get emails from Supabase students table for matching
    const { data: studentsWithEmail } = await supabase.from('students').select('id, email')
    const supaIdToEmail: Record<string, string> = {}
    if (studentsWithEmail) {
      for (const s of studentsWithEmail) {
        if (s.email) supaIdToEmail[s.id] = s.email.toLowerCase()
      }
    }

    if (fbUsers) {
      for (const [fbUid, userData] of Object.entries(fbUsers as Record<string, any>)) {
        // Match by supabaseStudentId
        if (userData?.supabaseStudentId) {
          supaToFirebase[userData.supabaseStudentId] = fbUid
        }
        // Match by email
        if (userData?.email) {
          const fbEmail = userData.email.toLowerCase()
          for (const [supaId, supaEmail] of Object.entries(supaIdToEmail)) {
            if (supaEmail === fbEmail) {
              supaToFirebase[supaId] = fbUid
            }
          }
        }
      }
    }

    const weekKey = getWeekKey()
    const results: any[] = []

    for (const student of students) {
      // Use Firebase UID if we have a mapping, otherwise fall back to student.id
      const uid = supaToFirebase[student.id] || student.id
      const snapshot: any = { scrapedAt: new Date().toISOString() }

      // Get previous data to calculate new followers
      const prevData = await firebaseGet(FIREBASE_DB_URL, `portal/social_history/${uid}/${weekKey}`)

      // ── INSTAGRAM ──
      if (student.instagram_handle) {
        try {
          const handle = student.instagram_handle.replace('@', '').replace(/\//g, '')
          const runRes = await fetch(
            `https://api.apify.com/v2/acts/apify~instagram-profile-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                usernames: [handle],
              }),
            }
          )

          if (runRes.ok) {
            const profiles = await runRes.json()
            if (profiles && profiles.length > 0) {
              const p = profiles[0]
              snapshot.igFollowers = p.followersCount || p.followedByCount || 0
              snapshot.igPosts = p.postsCount || p.mediaCount || 0

              // Get total views by summing views from scraped reels in Supabase videos table
              const { data: videos } = await supabase.from('videos').select('views').eq('student_id', student.id)
              const totalViews = videos ? videos.reduce((sum: number, v: any) => sum + (v.views || 0), 0) : 0
              snapshot.igViews = totalViews || p.profileViewsCount || 0

              // Calculate new followers
              const prevFollowers = prevData?.igFollowers || 0
              snapshot.igNewFollowers = snapshot.igFollowers - prevFollowers
            }
          } else {
            console.error(`Apify IG error for @${student.instagram_handle}:`, await runRes.text())
          }
        } catch (e) {
          console.error(`IG scrape failed for ${student.instagram_handle}:`, e.message)
        }
      }

      // ── TIKTOK ──
      // Check Firebase social_profiles for TikTok URL if not in Supabase
      let tiktokUrl = student.tiktok_url || null
      if (!tiktokUrl) {
        const fbProfile = await firebaseGet(FIREBASE_DB_URL, `portal/social_profiles/${uid}`)
        if (fbProfile?.tiktokUrl) tiktokUrl = fbProfile.tiktokUrl
      }
      if (tiktokUrl) {
        try {
          // Extract username from URL
          const ttMatch = tiktokUrl.match(/@([\w.]+)/)
          const ttUsername = ttMatch ? ttMatch[1] : tiktokUrl.replace(/https?:\/\/(www\.)?tiktok\.com\/@?/, '').replace(/\//g, '')

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
              const profiles = await runRes.json()
              if (profiles && profiles.length > 0) {
                const p = profiles[0]
                snapshot.ttFollowers = p.authorMeta?.fans || p.fans || p.followerCount || 0
                snapshot.ttPosts = p.authorMeta?.video || p.videoCount || 0
                snapshot.ttViews = p.authorMeta?.heart || p.heartCount || p.totalLikes || 0

                // Calculate new followers
                const prevFollowers = prevData?.ttFollowers || 0
                snapshot.ttNewFollowers = snapshot.ttFollowers - prevFollowers
              }
            } else {
              console.error(`Apify TT error for ${ttUsername}:`, await runRes.text())
            }
          }
        } catch (e) {
          console.error(`TT scrape failed for ${student.tiktok_url}:`, e.message)
        }
      }

      // Save to Firebase (overwrite current week with latest data)
      const saved = await firebaseSet(FIREBASE_DB_URL, `portal/social_history/${uid}/${weekKey}`, snapshot)
      results.push({ uid, weekKey, saved, snapshot })
    }

    return new Response(JSON.stringify({ success: true, weekKey, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
