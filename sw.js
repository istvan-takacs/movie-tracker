const CACHE_NAME = 'movietracker-v2';

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

// ─── Activate: clean old caches ────────────────────────────────────
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
            ))
            .then(() => self.clients.claim())
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
