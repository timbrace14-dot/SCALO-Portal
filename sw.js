// SCALO Push Notification Service Worker

self.addEventListener('push', (event) => {
    const data = event.data ? event.data.json() : {};
    const title = data.title || 'SCALO';
    const options = {
        body: data.body || "You haven't logged today's numbers, jump in and track your progress",
        icon: data.icon || '/favicon.ico',
        badge: data.badge || '/favicon.ico',
        tag: 'scalo-daily-reminder',
        renotify: true,
        data: {
            url: data.url || 'https://buildwithscalo.com'
        }
    };
    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    const url = event.notification.data?.url || 'https://buildwithscalo.com';
    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
            for (const client of windowClients) {
                if (client.url.includes('buildwithscalo.com') && 'focus' in client) {
                    return client.focus();
                }
            }
            return clients.openWindow(url);
        })
    );
});

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));
