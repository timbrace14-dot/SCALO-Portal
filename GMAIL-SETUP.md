# Gmail API Setup Guide for SCALO Expiring Client Notifications

This guide walks you through setting up the Gmail API so the `notify-expiring-clients` edge function can send you daily email alerts about clients approaching their programme end date.

---

## Step 1: Create a Google Cloud Project

1. Go to [Google Cloud Console](https://console.cloud.google.com/)
2. Click the project dropdown (top left) and click **New Project**
3. Name it something like `SCALO Notifications` and click **Create**
4. Make sure the new project is selected in the dropdown

## Step 2: Enable the Gmail API

1. In the Google Cloud Console, go to **APIs & Services > Library**
2. Search for **Gmail API**
3. Click on it and click **Enable**

## Step 3: Configure the OAuth Consent Screen

1. Go to **APIs & Services > OAuth consent screen**
2. Select **External** as the user type (unless you have a Google Workspace org, then choose Internal)
3. Fill in the required fields:
   - App name: `SCALO Notifications`
   - User support email: `timbrace14@gmail.com`
   - Developer contact email: `timbrace14@gmail.com`
4. Click **Save and Continue**
5. On the **Scopes** step, click **Add or Remove Scopes**
6. Find and add: `https://www.googleapis.com/auth/gmail.send`
7. Click **Save and Continue**
8. On the **Test users** step, click **Add Users** and add `timbrace14@gmail.com`
9. Click **Save and Continue**, then **Back to Dashboard**

## Step 4: Create OAuth 2.0 Credentials

1. Go to **APIs & Services > Credentials**
2. Click **Create Credentials > OAuth client ID**
3. Application type: **Web application**
4. Name: `SCALO Notifications`
5. Under **Authorized redirect URIs**, add: `https://developers.google.com/oauthplayground`
6. Click **Create**
7. Copy and save the **Client ID** and **Client Secret** somewhere safe

## Step 5: Get a Refresh Token

1. Go to [OAuth 2.0 Playground](https://developers.google.com/oauthplayground)
2. Click the **gear icon** (top right) and check **Use your own OAuth credentials**
3. Enter your **Client ID** and **Client Secret** from Step 4
4. In the left panel under **Step 1**, find **Gmail API v1** and select:
   - `https://www.googleapis.com/auth/gmail.send`
5. Click **Authorize APIs**
6. Sign in with `timbrace14@gmail.com` and grant access
7. On **Step 2**, click **Exchange authorization code for tokens**
8. Copy the **Refresh Token** from the response

## Step 6: Add Secrets to Supabase

Run these commands in your terminal (replace the placeholder values with your actual credentials):

```bash
supabase secrets set GMAIL_CLIENT_ID="your-client-id-here"
supabase secrets set GMAIL_CLIENT_SECRET="your-client-secret-here"
supabase secrets set GMAIL_REFRESH_TOKEN="your-refresh-token-here"
```

Verify they are set:

```bash
supabase secrets list
```

You should see `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, and `GMAIL_REFRESH_TOKEN` listed alongside your existing `FIREBASE_DATABASE_URL` secret.

## Step 7: Deploy the Edge Function

From the `supabase` directory in your SCALO project:

```bash
cd /Users/timbrace/Desktop/SCALO/supabase
supabase functions deploy notify-expiring-clients
```

## Step 8: Test Manually

Trigger the function manually to verify it works:

```bash
curl -X POST "https://kadgzthwuzzjwxxcbgzi.supabase.co/functions/v1/notify-expiring-clients" \
  -H "Authorization: Bearer YOUR_ANON_KEY" \
  -H "Content-Type: application/json"
```

You should receive a JSON response showing which clients were flagged, and an email should arrive at `timbrace14@gmail.com` for each client within 30 days of their programme end.

## Step 9: Set Up the Daily Cron Schedule

1. Go to your Supabase Dashboard > **SQL Editor**
2. Run the new cron entry from `setup-cron-schedules.sql` (the `notify-expiring-clients-daily` block)
3. Verify it is scheduled by running: `SELECT * FROM cron.job;`

The function will now run every day at 8:00 AM UTC automatically.

---

## Troubleshooting

- **"Gmail send failed (401)"** — Your refresh token may have expired. Re-do Step 5 to get a new one, then update the secret with `supabase secrets set GMAIL_REFRESH_TOKEN="new-token"`
- **"No clients expiring within 30 days"** — This means none of your clients have a `programmeEnd` date within the next 30 days. Set dates in the CRM page first.
- **Not receiving emails** — Check your spam folder. Also verify the Gmail API is enabled and the test user is added in the OAuth consent screen.
- **Publishing the app** — While the app is in "Testing" mode, only test users can use it. Since you are the only user, this is fine. If the refresh token expires every 7 days, click **Publish App** on the OAuth consent screen to make it permanent (no verification needed since you are the only user).
