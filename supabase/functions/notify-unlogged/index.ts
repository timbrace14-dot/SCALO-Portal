// Supabase Edge Function: notify-unlogged
// Sends push notifications to students who haven't logged their daily numbers.
// Triggered daily at 8pm UK time via pg_cron.
//
// Required env vars (set in Supabase Dashboard > Edge Functions > Secrets):
//   FIREBASE_DATABASE_URL   — e.g. https://scalo-client-portal-default-rtdb.firebaseio.com
//   VAPID_PRIVATE_KEY       — ECDSA P-256 private key (base64url)
//   VAPID_PUBLIC_KEY        — ECDSA P-256 public key (base64url)

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

// Get current week key and day index (0=Mon ... 6=Sun)
function getCurrentWeekAndDay(): { weekKey: string; dayIndex: number } {
  const now = new Date()
  // Convert to UK time
  const ukTime = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/London' }))
  const jan1 = new Date(ukTime.getFullYear(), 0, 1)
  const days = Math.floor((ukTime.getTime() - jan1.getTime()) / 86400000)
  const week = Math.ceil((days + jan1.getDay() + 1) / 7)
  const weekKey = `${ukTime.getFullYear()}_W${String(week).padStart(2, '0')}`
  // JS getDay: 0=Sun, 1=Mon ... 6=Sat → convert to 0=Mon ... 6=Sun
  const jsDay = ukTime.getDay()
  const dayIndex = jsDay === 0 ? 6 : jsDay - 1
  return { weekKey, dayIndex }
}

// Base64url encode
function base64urlEncode(data: Uint8Array): string {
  return btoa(String.fromCharCode(...data))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

// Base64url decode
function base64urlDecode(str: string): Uint8Array {
  const padding = '='.repeat((4 - str.length % 4) % 4)
  const base64 = (str + padding).replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(base64)
  return Uint8Array.from([...binary].map(c => c.charCodeAt(0)))
}

// Create VAPID JWT
async function createVapidJwt(audience: string, subject: string, privateKeyBase64: string): Promise<string> {
  const header = { typ: 'JWT', alg: 'ES256' }
  const now = Math.floor(Date.now() / 1000)
  const payload = { aud: audience, exp: now + 86400, sub: subject }

  const enc = new TextEncoder()
  const headerB64 = base64urlEncode(enc.encode(JSON.stringify(header)))
  const payloadB64 = base64urlEncode(enc.encode(JSON.stringify(payload)))
  const unsigned = `${headerB64}.${payloadB64}`

  // Import private key
  const rawKey = base64urlDecode(privateKeyBase64)
  // PKCS8 wrapping for P-256 private key
  const pkcs8Prefix = new Uint8Array([
    0x30, 0x81, 0x87, 0x02, 0x01, 0x00, 0x30, 0x13,
    0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02,
    0x01, 0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d,
    0x03, 0x01, 0x07, 0x04, 0x6d, 0x30, 0x6b, 0x02,
    0x01, 0x01, 0x04, 0x20
  ])
  const pkcs8Suffix = new Uint8Array([
    0xa1, 0x44, 0x03, 0x42, 0x00
  ])

  // We need the public key for PKCS8 — but we can sign with just the raw key using JWK
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: privateKeyBase64,
    x: '', // Will be derived
    y: '',
  }

  // Actually, let's use a simpler approach: import as JWK with x,y from public key
  // For now, use the raw private key directly
  const keyData = rawKey

  // Use SubtleCrypto with JWK import
  // We need x and y coordinates from the public key
  const pubKeyBase64 = Deno.env.get('VAPID_PUBLIC_KEY') || ''
  const pubKeyRaw = base64urlDecode(pubKeyBase64)
  // Uncompressed public key: 0x04 + x(32 bytes) + y(32 bytes)
  const x = base64urlEncode(pubKeyRaw.slice(1, 33))
  const y = base64urlEncode(pubKeyRaw.slice(33, 65))
  const d = privateKeyBase64

  const cryptoKey = await crypto.subtle.importKey(
    'jwk',
    { kty: 'EC', crv: 'P-256', x, y, d },
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  )

  const signature = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    cryptoKey,
    enc.encode(unsigned)
  )

  // Convert DER signature to raw r||s format if needed
  const sigBytes = new Uint8Array(signature)
  let sigB64: string
  if (sigBytes.length === 64) {
    sigB64 = base64urlEncode(sigBytes)
  } else {
    // DER encoded — parse r and s
    let offset = 2
    const rLen = sigBytes[offset + 1]
    const r = sigBytes.slice(offset + 2, offset + 2 + rLen)
    offset = offset + 2 + rLen
    const sLen = sigBytes[offset + 1]
    const s = sigBytes.slice(offset + 2, offset + 2 + sLen)
    // Pad/trim to 32 bytes each
    const rPad = new Uint8Array(32)
    const sPad = new Uint8Array(32)
    rPad.set(r.length > 32 ? r.slice(r.length - 32) : r, 32 - Math.min(r.length, 32))
    sPad.set(s.length > 32 ? s.slice(s.length - 32) : s, 32 - Math.min(s.length, 32))
    const rawSig = new Uint8Array(64)
    rawSig.set(rPad, 0)
    rawSig.set(sPad, 32)
    sigB64 = base64urlEncode(rawSig)
  }

  return `${unsigned}.${sigB64}`
}

// Send a single web push notification
async function sendPushNotification(
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: object,
  vapidPrivateKey: string,
  vapidPublicKey: string
): Promise<boolean> {
  try {
    const endpointUrl = new URL(subscription.endpoint)
    const audience = `${endpointUrl.protocol}//${endpointUrl.host}`

    const jwt = await createVapidJwt(audience, 'mailto:timbrace14@gmail.com', vapidPrivateKey)

    // Encrypt payload using Web Push encryption (aes128gcm)
    const payloadBytes = new TextEncoder().encode(JSON.stringify(payload))

    // Generate salt and local key pair
    const salt = crypto.getRandomValues(new Uint8Array(16))
    const localKeyPair = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits'])

    // Import subscriber's public key
    const subscriberPubRaw = base64urlDecode(subscription.keys.p256dh)
    const subscriberPub = await crypto.subtle.importKey('raw', subscriberPubRaw, { name: 'ECDH', namedCurve: 'P-256' }, false, [])

    // Derive shared secret
    const sharedSecret = await crypto.subtle.deriveBits({ name: 'ECDH', public: subscriberPub }, localKeyPair.privateKey, 256)

    // Auth secret
    const authSecret = base64urlDecode(subscription.keys.auth)

    // HKDF for PRK
    const enc = new TextEncoder()
    const ikmKey = await crypto.subtle.importKey('raw', new Uint8Array(sharedSecret), { name: 'HKDF' }, false, ['deriveBits'])

    // PRK = HKDF-Extract(auth_secret, shared_secret)
    const prkSalt = await crypto.subtle.importKey('raw', authSecret, { name: 'HKDF' }, false, ['deriveBits'])
    const prkMaterial = await crypto.subtle.importKey('raw', new Uint8Array(sharedSecret), 'HKDF', false, ['deriveBits'])

    // Use HKDF with the standard Web Push info strings
    const localPubRaw = await crypto.subtle.exportKey('raw', localKeyPair.publicKey)
    const localPubBytes = new Uint8Array(localPubRaw)

    // Key info = "WebPush: info\0" + subscriber_pub + local_pub
    const keyInfoHeader = enc.encode('WebPush: info\0')
    const keyInfo = new Uint8Array(keyInfoHeader.length + subscriberPubRaw.length + localPubBytes.length)
    keyInfo.set(keyInfoHeader, 0)
    keyInfo.set(subscriberPubRaw, keyInfoHeader.length)
    keyInfo.set(localPubBytes, keyInfoHeader.length + subscriberPubRaw.length)

    // IKM = HKDF(salt=auth_secret, ikm=ecdh_secret, info="WebPush: info\0"..., len=32)
    const ikmMaterial = await crypto.subtle.importKey('raw', new Uint8Array(sharedSecret), 'HKDF', false, ['deriveBits'])
    const ikm = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt: authSecret, info: keyInfo }, ikmMaterial, 256))

    // CEK = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: aes128gcm\0", len=16)
    const cekInfo = enc.encode('Content-Encoding: aes128gcm\0')
    const cekMaterial = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    const cek = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: cekInfo }, cekMaterial, 128))

    // Nonce = HKDF(salt=salt, ikm=ikm, info="Content-Encoding: nonce\0", len=12)
    const nonceInfo = enc.encode('Content-Encoding: nonce\0')
    const nonceMaterial = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits'])
    const nonce = new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info: nonceInfo }, nonceMaterial, 96))

    // Encrypt: AES-128-GCM
    const aesKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt'])
    // Add padding delimiter
    const paddedPayload = new Uint8Array(payloadBytes.length + 1)
    paddedPayload.set(payloadBytes)
    paddedPayload[payloadBytes.length] = 2 // delimiter

    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, paddedPayload))

    // Build aes128gcm header: salt(16) + rs(4) + idlen(1) + keyid(65) + encrypted
    const rs = new Uint8Array(4)
    new DataView(rs.buffer).setUint32(0, 4096)

    const header = new Uint8Array(16 + 4 + 1 + localPubBytes.length)
    header.set(salt, 0)
    header.set(rs, 16)
    header[20] = localPubBytes.length
    header.set(localPubBytes, 21)

    const body = new Uint8Array(header.length + encrypted.length)
    body.set(header, 0)
    body.set(encrypted, header.length)

    // Send to push endpoint
    const res = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        'Authorization': `vapid t=${jwt}, k=${vapidPublicKey}`,
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        'TTL': '86400',
        'Urgency': 'normal',
      },
      body,
    })

    if (res.status === 201 || res.status === 200) return true
    console.error(`Push failed (${res.status}):`, await res.text())
    return false
  } catch (err) {
    console.error('Push send error:', (err as Error).message)
    return false
  }
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })

  try {
    const FB_URL = Deno.env.get('FIREBASE_DATABASE_URL') || 'https://scalo-client-portal-default-rtdb.firebaseio.com'
    const VAPID_PRIVATE = Deno.env.get('VAPID_PRIVATE_KEY')
    const VAPID_PUBLIC = Deno.env.get('VAPID_PUBLIC_KEY')
    if (!VAPID_PRIVATE || !VAPID_PUBLIC) throw new Error('VAPID keys not configured')

    const { weekKey, dayIndex } = getCurrentWeekAndDay()

    // Get all users
    const usersRes = await fetch(`${FB_URL}/portal/users.json`)
    const users = await usersRes.json()
    if (!users) throw new Error('No users found')

    // Get all push subscriptions
    const subsRes = await fetch(`${FB_URL}/portal/push_subscriptions.json`)
    const subscriptions = await subsRes.json()

    // Get weekly data for current week
    const weekDataRes = await fetch(`${FB_URL}/portal/weekly_data/${weekKey}.json`)
    const weekData = await weekDataRes.json()

    const results: any[] = []

    for (const [uid, userData] of Object.entries(users as Record<string, any>)) {
      // Skip admins and disabled users
      if (userData.role === 'admin' || userData.disabled) continue

      // Check if they have a push subscription
      const sub = subscriptions?.[uid]
      if (!sub?.endpoint || !sub?.keys) continue

      // Check if they've logged today's data
      const userWeek = weekData?.[uid]
      const todayData = userWeek?.[`day${dayIndex}`]
      const hasLogged = todayData && Object.values(todayData).some((v: any) => v !== null && v !== '' && v !== 0)

      if (!hasLogged) {
        // Send push notification
        const success = await sendPushNotification(
          sub,
          {
            title: 'SCALO',
            body: "You haven't logged today's numbers, jump in and track your progress",
            url: 'https://buildwithscalo.com'
          },
          VAPID_PRIVATE,
          VAPID_PUBLIC
        )
        results.push({ uid, firstName: userData.firstName, sent: success })
      } else {
        results.push({ uid, firstName: userData.firstName, skipped: 'already logged' })
      }
    }

    return new Response(JSON.stringify({ success: true, weekKey, dayIndex, results }), {
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  } catch (err) {
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    })
  }
})
