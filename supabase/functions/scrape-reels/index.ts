// Supabase Edge Function: scrape-reels
// Scrapes top 20 Instagram reels for each student and stores in Firebase.
// Reads student Instagram handles from Firebase (not Supabase).
// Triggered daily via pg_cron or manually from the client.
//
// Required env vars (set in Supabase Dashboard > Edge Functions > Secrets):
//   APIFY_API_TOKEN         — your Apify API key
//   FIREBASE_DATABASE_URL   — e.g. https://scalo-client-portal-default-rtdb.firebaseio.com

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN')
    if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not configured')

    const FB_URL = Deno.env.get('FIREBASE_DATABASE_URL') || 'https://scalo-client-portal-default-rtdb.firebaseio.com'

    // Optional: target a specific user by uid
    const { uid } = await req.json().catch(() => ({}))

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
      if (uid && fbUid !== uid) continue // skip if targeting specific user

      // Get Instagram handle from social_profiles
      const profile = profiles?.[fbUid]
      if (!profile?.instagramUrl) continue

      const handle = profile.instagramUrl
        .replace(/https?:\/\/(www\.)?instagram\.com\//i, '')
        .replace(/[?#].*$/, '')
        .replace(/\//g, '')

      if (handle) students.push({ uid: fbUid, handle })
    }

    if (students.length === 0) {
      return new Response(JSON.stringify({ message: 'No students with Instagram handles found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const results: any[] = []

    for (const student of students) {
      try {
        // Use Apify Instagram Reel Scraper
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

        // Map Apify output to our content library schema
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

        // Save to Firebase — overwrite content library for this user
        const saveRes = await fetch(`${FB_URL}/portal/content_library/${student.uid}.json`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(videos),
        })

        if (!saveRes.ok) {
          results.push({ uid: student.uid, handle: student.handle, error: `Firebase save failed: ${saveRes.status}` })
        } else {
          results.push({ uid: student.uid, handle: student.handle, count: Object.keys(videos).length, scraped_at: now })
        }
      } catch (e) {
        results.push({ uid: student.uid, handle: student.handle, error: (e as Error).message })
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
