const CACHE_NAME = 'movietracker-v3';

// Derive base path from SW location (works on both localhost and GitHub Pages)
const BASE = new URL('.', self.location).pathname;

const PRE_CACHE_FILES = [
    '',
    'index.html',
    'style.css',
    'app.js',
    'firebase-config.js',
    'manifest.json',
    'icons/icon-192.png',
    'icons/icon-512.png',
];
const PRE_CACHE = PRE_CACHE_FILES.map(f => BASE + f);

// ─── Install: pre-cache core assets ────────────────────────────────
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(PRE_CACHE))
            .then(() => self.skipWaiting())
    );
});

// ─── Activate: clean old caches, register periodic sync ────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
    );
});

// ─── Background release notifications ──────────────────────────────
// Checks localStorage for watchlist movies releasing today/tomorrow
// and shows push-style notifications even when the app isn't open.

function checkReleasesInBackground() {
    try {
        const raw = localStorage.getItem('mt-watchlist');
        if (!raw) return;
        const movies = JSON.parse(raw);

        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];
        const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

        const notifiedRaw = localStorage.getItem('mt-notified') || '{}';
        const notified = JSON.parse(notifiedRaw);

        const notifications = [];

        movies.forEach(m => {
            if (!m.releaseDate) return;

            // Use date-keyed dedup so "tomorrow" and "today" are separate
            const dayKey = `${m.tmdbId}-${todayStr}`;

            if (m.releaseDate === todayStr && !notified[dayKey]) {
                notifications.push({
                    title: 'Movie Tracker',
                    options: {
                        body: `"${m.title}" releases today!`,
                        icon: m.posterPath ? `https://image.tmdb.org/t/p/w92${m.posterPath}` : undefined,
                        tag: `release-${m.tmdbId}-today`,
                        badge: BASE + 'icons/icon-192.png'
                    }
                });
                notified[dayKey] = 1;
            } else if (m.releaseDate === tomorrow && !notified[`${m.tmdbId}-tomorrow-${todayStr}`]) {
                notifications.push({
                    title: 'Movie Tracker',
                    options: {
                        body: `"${m.title}" releases tomorrow!`,
                        icon: m.posterPath ? `https://image.tmdb.org/t/p/w92${m.posterPath}` : undefined,
                        tag: `release-${m.tmdbId}-tomorrow`,
                        badge: BASE + 'icons/icon-192.png'
                    }
                });
                notified[`${m.tmdbId}-tomorrow-${todayStr}`] = 1;
            }
        });

        // Clean old dedup keys (older than 3 days)
        const threeDaysAgo = new Date(Date.now() - 3 * 86400000).toISOString().split('T')[0];
        for (const key of Object.keys(notified)) {
            const datePart = key.split('-').slice(-1)[0] || key.match(/\d{4}-\d{2}-\d{2}/)?.[0];
            if (datePart && datePart < threeDaysAgo) {
                delete notified[key];
            }
        }

        localStorage.setItem('mt-notified', JSON.stringify(notified));

        return Promise.all(notifications.map(n =>
            self.registration.showNotification(n.title, n.options)
        ));
    } catch (err) {
        console.error('Background notification check failed:', err);
    }
}

// Periodic Background Sync (Chrome/Edge for installed PWAs)
self.addEventListener('periodicsync', (event) => {
    if (event.tag === 'check-releases') {
        event.waitUntil(checkReleasesInBackground());
    }
});

// Also check on regular sync events (triggered by app when it goes online)
self.addEventListener('sync', (event) => {
    if (event.tag === 'check-releases') {
        event.waitUntil(checkReleasesInBackground());
    }
});

// Notification click — open the app
self.addEventListener('notificationclick', (event) => {
    event.notification.close();
    event.waitUntil(
        self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
            // Focus existing window if available
            for (const client of clients) {
                if (client.url.includes('movie-tracker') && 'focus' in client) {
                    return client.focus();
                }
            }
            // Otherwise open a new window
            return self.clients.openWindow(BASE);
        })
    );
});

// ─── Fetch: multi-strategy caching ─────────────────────────────────
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // Skip caching in development
    if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') return;

    // Network-only: Firebase API calls (Firestore, Auth)
    if (url.hostname.includes('firebaseio.com') ||
        url.hostname.includes('googleapis.com') ||
        url.hostname.includes('identitytoolkit') ||
        url.hostname.includes('securetoken')) {
        return;
    }

    // Network-first: TMDB API (always want fresh data, fallback to cache)
    if (url.hostname === 'api.themoviedb.org') {
        event.respondWith(
            fetch(event.request)
                .then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                })
                .catch(() => caches.match(event.request))
        );
        return;
    }

    // Cache-first: TMDB poster images (immutable by path)
    if (url.hostname === 'image.tmdb.org') {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                });
            })
        );
        return;
    }

    // Cache-first: Firebase SDK (versioned, immutable)
    if (url.hostname.includes('gstatic.com')) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                });
            })
        );
        return;
    }

    // Cache-first: Google Fonts
    if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    const clone = response.clone();
                    caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    return response;
                });
            })
        );
        return;
    }

    // Cache-first: local assets (same origin)
    if (url.origin === self.location.origin) {
        event.respondWith(
            caches.match(event.request).then(cached => {
                if (cached) return cached;
                return fetch(event.request)
                    .then(response => {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                        return response;
                    })
                    .catch(() => {
                        // Offline navigation fallback
                        if (event.request.mode === 'navigate') {
                            return caches.match(BASE + 'index.html');
                        }
                    });
            })
        );
        return;
    }
});
