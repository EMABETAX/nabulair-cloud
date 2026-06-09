// =============================================
// SW-REMOTE.JS — Service Worker per Web Push
// NabulAir v1.5
// =============================================

const CACHE_NAME = 'nabulair-remote-v2';

// Installa e attiva
self.addEventListener('install', e => {
    e.waitUntil(
        caches.open(CACHE_NAME).then(cache =>
            cache.addAll(['/remote.html', '/logo.png'])
        ).then(() => self.skipWaiting())
    );
});

self.addEventListener('activate', e => {
    e.waitUntil(
        caches.keys().then(keys =>
            Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
        ).then(() => self.clients.claim())
    );
});

// Fetch — network first per le API, cache first per i file statici
self.addEventListener('fetch', e => {
    // Non intercettare le richieste API
    if (e.request.url.includes('/api/')) return;

    e.respondWith(
        caches.match(e.request).then(cached => {
            if (cached) return cached;
            return fetch(e.request).then(response => {
                if (response && response.status === 200 && response.type === 'basic') {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(c => c.put(e.request, clone));
                }
                return response;
            }).catch(() => cached);
        })
    );
});

// ── Push notification handler ──
self.addEventListener('push', e => {
    let data = { title: 'NabulAir', body: 'Nuovo allarme', url: '/remote.html', icon: '/logo.png' };

    if (e.data) {
        try {
            data = { ...data, ...JSON.parse(e.data.text()) };
        } catch {}
    }

    const options = {
        body: data.body,
        icon: data.icon || '/logo.png',
        badge: '/logo.png',
        vibrate: [200, 100, 200],
        data: { url: data.url || '/remote.html' },
        actions: [
            { action: 'open',    title: '📱 Apri app' },
            { action: 'dismiss', title: '✕ Chiudi' }
        ],
        requireInteraction: true  // non scompare automaticamente su Android
    };

    e.waitUntil(
        self.registration.showNotification(data.title, options)
    );
});

// ── Notification click handler ──
self.addEventListener('notificationclick', e => {
    e.notification.close();

    if (e.action === 'dismiss') return;

    const urlToOpen = e.notification.data?.url || '/remote.html';

    e.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(windowClients => {
            // Se l'app è già aperta, portala in primo piano
            for (const client of windowClients) {
                if (client.url.includes('/remote.html') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Altrimenti apri una nuova finestra
            if (clients.openWindow) {
                return clients.openWindow(urlToOpen);
            }
        })
    );
});

// Gestione messaggi dal client
self.addEventListener('message', e => {
    if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
});
