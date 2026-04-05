// Supabase Edge Function: scrape-inspo
// Scrapes top 4 reels from each user's inspiration creators and stores in Firebase.
// Triggered weekly (Monday 8am) via pg_cron or manually from the client.
//
// Required env vars:
//   APIFY_API_TOKEN
//   FIREBASE_DATABASE_URL   — e.g. https://your-project.firebaseio.com
//   FIREBASE_SERVICE_KEY     — Firebase service account JSON (base64 encoded)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Helper: get current ISO week key like "2026_W14"
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
    const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN')
    const FB_URL = Deno.env.get('FIREBASE_DATABASE_URL')
    if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not configured')
    if (!FB_URL) throw new Error('FIREBASE_DATABASE_URL not configured')

    // Optional: target a specific user
    const { uid } = await req.json().catch(() => ({}))
    const weekKey = getWeekKey()

    // Get all users' inspo creators from Firebase
    const creatorsUrl = uid
      ? `${FB_URL}/portal/inspo_creators/${uid}.json`
      : `${FB_URL}/portal/inspo_creators.json`
    const creatorsRes = await fetch(creatorsUrl)
    const creatorsData = await creatorsRes.json()

    if (!creatorsData) {
      return new Response(JSON.stringify({ message: 'No inspo creators configured' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    // Normalize: if single user, wrap in { uid: data }
    const allUsers = uid ? { [uid]: creatorsData } : creatorsData
    const results: any[] = []

    for (const [userId, creators] of Object.entries(allUsers)) {
      if (!creators || typeof creators !== 'object') continue
      const creatorEntries = Object.entries(creators as Record<string, any>)
      const weekVideos: Record<string, any> = {}

      for (const [, creator] of creatorEntries) {
        const handle = (creator as any).handle
        if (!handle) continue

        try {
          // Scrape top 4 reels for this creator
          const runRes = await fetch(
            `https://api.apify.com/v2/acts/apify~instagram-reel-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                username: [handle.replace('@', '')],
                resultsLimit: 4,
              }),
            }
          )

          if (!runRes.ok) {
            results.push({ userId, handle, error: await runRes.text() })
            continue
          }

          const reels = await runRes.json()

          for (const reel of reels.slice(0, 4)) {
            const id = crypto.randomUUID().replace(/-/g, '').slice(0, 20)
            weekVideos[id] = {
              creatorHandle: handle,
              caption: (reel.caption || '').slice(0, 300),
              views: reel.videoViewCount || reel.playCount || 0,
              likes: reel.likesCount || 0,
              comments: reel.commentsCount || 0,
              link: reel.url || '',
              thumbnail: reel.displayUrl || reel.thumbnailUrl || '',
              whyItWorks: '', // Can be filled by admin later
            }
          }

          results.push({ userId, handle, count: Math.min(reels.length, 4) })
        } catch (e) {
          results.push({ userId, handle, error: (e as Error).message })
        }
      }

      // Save to Firebase under the current week
      if (Object.keys(weekVideos).length > 0) {
        const saveRes = await fetch(
          `${FB_URL}/portal/inspo_videos/${userId}/${weekKey}.json`,
          {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(weekVideos),
          }
        )
        if (!saveRes.ok) {
          results.push({ userId, error: `Firebase save failed: ${saveRes.status}` })
        }
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
