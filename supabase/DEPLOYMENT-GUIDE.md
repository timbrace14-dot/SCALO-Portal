# SCALO — Scraping & Email Deployment Guide

## What was fixed / added

### 1. PDF Export (fixed)
The "Export PDF" button was failing with `null is not an object (evaluating 'w.document')` because browsers block popups. All 4 PDF export functions now use a `printHTMLContent()` helper that falls back to a hidden iframe when popups are blocked. **No deployment needed — this fix is in `index.html`.**

### 2. Content Library Auto-Scrape (new)
Created a Supabase Edge Function (`scrape-reels`) that scrapes Instagram reels via the Apify API and stores them in your Supabase `videos` table. Triggers automatically when data is older than 24 hours, and has a manual "Refresh" button.

### 3. Content Inspo Weekly Scrape (new)
Created a Supabase Edge Function (`scrape-inspo`) that scrapes the top 4 reels from each user's inspiration creators every Monday and stores them in Firebase.

### 4. Monday Morning Email (new)
Created a Supabase Edge Function (`send-inspo-email`) that sends each user a styled email with their weekly content inspo. Uses Resend.com for email delivery.

---

## Deployment Steps

### Prerequisites
- [Supabase CLI](https://supabase.com/docs/guides/cli) installed
- [Apify](https://apify.com) account — sign up and get an API token
- [Resend](https://resend.com) account — sign up and get an API key
- Your Supabase project linked: `supabase link --project-ref kadgzthwuzzjwxxcbgzi`

### Step 1: Set Edge Function Secrets
```bash
supabase secrets set APIFY_API_TOKEN=your_apify_token_here
supabase secrets set FIREBASE_DATABASE_URL=https://your-firebase-project.firebaseio.com
supabase secrets set RESEND_API_KEY=your_resend_api_key_here
supabase secrets set FROM_EMAIL="SCALO <hello@yourdomain.com>"
```

### Step 2: Deploy Edge Functions
```bash
cd supabase
supabase functions deploy scrape-reels
supabase functions deploy scrape-inspo
supabase functions deploy send-inspo-email
```

### Step 3: Set Up Scheduling (pg_cron)
1. Go to Supabase Dashboard → Database → Extensions
2. Enable `pg_cron` and `pg_net`
3. Go to SQL Editor and run the contents of `setup-cron-schedules.sql`

This sets up:
- **Daily 8:00 AM UTC** — `scrape-reels` for content library
- **Monday 7:45 AM UTC** — `scrape-inspo` for inspiration creators
- **Monday 8:00 AM UTC** — `send-inspo-email` for the Monday email

### Step 4: Verify
- Visit the Content Library page — if data is >24h old, it auto-triggers a scrape
- Visit the Inspo page — on Mondays, it auto-triggers if no data exists for the current week
- Both pages have a manual "Refresh" button for on-demand scraping
