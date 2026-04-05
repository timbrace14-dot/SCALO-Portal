// Supabase Edge Function: scrape-reels
// Scrapes top 20 Instagram reels for a student's profile and upserts into Supabase videos table.
// Triggered daily via pg_cron or manually from the client.
//
// Required env vars (set in Supabase Dashboard > Edge Functions > Secrets):
//   APIFY_API_TOKEN    — your Apify API key (https://console.apify.com/account#/integrations)
//   SUPABASE_URL       — auto-provided by Supabase
//   SUPABASE_SERVICE_ROLE_KEY — auto-provided by Supabase

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const APIFY_TOKEN = Deno.env.get('APIFY_API_TOKEN')
    if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not configured')

    const supabase = createClient(
      Deno.env.get('SUPABASE_URL')!,
      Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    )

    // Get all students (or a specific one if student_id is passed)
    const { student_id } = await req.json().catch(() => ({}))

    let query = supabase.from('students').select('id, instagram_handle')
    if (student_id) query = query.eq('id', student_id)

    const { data: students, error: studentsErr } = await query
    if (studentsErr) throw studentsErr
    if (!students || students.length === 0) {
      return new Response(JSON.stringify({ message: 'No students found' }), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      })
    }

    const results = []

    for (const student of students) {
      if (!student.instagram_handle) continue

      try {
        // Use Apify Instagram Reel Scraper
        const runRes = await fetch(
          `https://api.apify.com/v2/acts/apify~instagram-reel-scraper/run-sync-get-dataset-items?token=${APIFY_TOKEN}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              username: [student.instagram_handle.replace('@', '')],
              resultsLimit: 20,
            }),
          }
        )

        if (!runRes.ok) {
          const errText = await runRes.text()
          console.error(`Apify error for @${student.instagram_handle}:`, errText)
          results.push({ handle: student.instagram_handle, error: errText })
          continue
        }

        const reels = await runRes.json()
        const now = new Date().toISOString()

        // Map Apify output to our videos table schema
        const videos = reels.slice(0, 20).map((reel: any) => ({
          student_id: student.id,
          caption: (reel.caption || '').slice(0, 500),
          views: reel.videoViewCount || reel.playCount || 0,
          plays: reel.videoPlayCount || reel.playCount || 0,
          likes: reel.likesCount || 0,
          comments: reel.commentsCount || 0,
          video_url: reel.url || reel.videoUrl || '',
          posted_at: reel.timestamp ? new Date(reel.timestamp).toISOString().slice(0, 10) : null,
          thumbnail_url: reel.displayUrl || reel.thumbnailUrl || '',
          scraped_at: now,
        }))

        // Delete old videos for this student, insert fresh ones
        await supabase.from('videos').delete().eq('student_id', student.id)
        const { error: insertErr } = await supabase.from('videos').insert(videos)

        if (insertErr) {
          results.push({ handle: student.instagram_handle, error: insertErr.message })
        } else {
          results.push({ handle: student.instagram_handle, count: videos.length, scraped_at: now })
        }
      } catch (e) {
        results.push({ handle: student.instagram_handle, error: e.message })
      }
    }

    return new Response(JSON.stringify({ success: true, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
