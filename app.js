// ─── Firebase imports ────────────────────────────────────────────────
import { firebaseConfig, googleClientId, omdbApiKey } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, getDocs, onSnapshot }
    from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { initializeAuth, browserLocalPersistence, browserPopupRedirectResolver,
    signInAnonymously, onAuthStateChanged, GoogleAuthProvider, signInWithPopup, signInWithCredential, linkWithPopup, signOut }
    from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";

// ─── Firebase init ───────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = initializeAuth(app, {
    persistence: browserLocalPersistence,
    popupRedirectResolver: browserPopupRedirectResolver,
});
const db = getFirestore(app);

// ─── TMDB config ─────────────────────────────────────────────────────
const TMDB_API_KEY = "c79a593d431f1406489c49f923bc042e";
const TMDB_BASE = "https://api.themoviedb.org/3";

// Streaming provider IDs for TMDB watch/providers
const STREAMING_PROVIDERS = '8|337|9|350|531|384|15'; // Netflix, Disney+, Prime, Apple TV+, Paramount+, Max, Hulu

// ─── App state ───────────────────────────────────────────────────────
let currentUser = null;
let userMovies = new Map();  // mediaKey(id, mediaType) → { status, title, mediaType, ... }
let genreMap = {};                // genreId → "Action", "Comedy", etc.
let currentMovies = [];           // undecided movies for the discover feed
let currentIndex = 0;
let currentPage = 1;
let totalPages = Infinity;        // track TMDB total pages to stop fetching
let isLoading = false;
let loadGeneration = 0;           // incremented on filter/search change to cancel stale loads
let isSwiping = false;
let trailerCache = new Map();     // tmdbId → YouTube URL (or null)
let castCache = new Map();        // tmdbId → [ { name, character, profilePath }, ... ]
let providerCache = new Map();    // tmdbId → [ { name, logoPath }, ... ] or []
let detailCache = new Map();      // tmdbId → full TMDB movie object
let omdbCache = new Map();        // imdbId → { imdb, rt } or null
let activeSource = 'all';  // 'all', 'theatrical', 'streaming', 'series'
let activeSortBy = localStorage.getItem('mt-sort') || 'relevance';
let isSearchMode = false;
let searchDebounceTimer = null;
let isGoogleSignInProgress = false; // guard against onAuthStateChanged re-triggering anon sign-in
let skippedQueue = [];            // movies skipped via down-swipe, re-shown after queue exhausted

// Separate page counters per source
let theatricalPage = 1;
let theatricalTotalPages = Infinity;
let streamingPage = 1;
let streamingTotalPages = Infinity;
let seriesPage = 1;
let seriesTotalPages = Infinity;
let watchlistMediaFilter = 'all';
let seenMediaFilter = 'all';
let dismissedMediaFilter = 'all';

// ─── DOM refs ────────────────────────────────────────────────────────
const cardStack = document.getElementById('card-stack');
const watchlistContainer = document.getElementById('watchlist-container');
const seenContainer = document.getElementById('seen-container');
const dismissedContainer = document.getElementById('dismissed-container');
const btnInterested = document.getElementById('btn-interested');
const btnDismiss = document.getElementById('btn-dismiss');
const bottomTabs = document.querySelectorAll('.bottom-tabs button');
const views = document.querySelectorAll('.view');
const discoverCounter = document.getElementById('discover-counter');
const searchInput = document.getElementById('search-input');
const searchClear = document.getElementById('search-clear');
const filterTabs = document.querySelectorAll('.filter-tab');

// ─── Auth ────────────────────────────────────────────────────────────
const googleProvider = new GoogleAuthProvider();

async function ensureAuth() {
    await auth.authStateReady();

    if (!auth.currentUser) {
        await signInAnonymously(auth);
    }

    currentUser = auth.currentUser;
    updateAuthUI();

    // Listen for future auth state changes
    onAuthStateChanged(auth, (user) => {
        if (user) {
            const prevUid = currentUser ? currentUser.uid : null;
            currentUser = user;
            updateAuthUI();
            if (prevUid && prevUid !== user.uid) {
                listenToDecisions();
                showCurrentCard();
            }
        } else if (!isGoogleSignInProgress) {
            signInAnonymously(auth);
        }
    });

    return currentUser;
}

async function signInWithGoogle() {
    isGoogleSignInProgress = true;
    try {
        // Snapshot anonymous data BEFORE switching users so we can merge it
        // after sign-in (Firestore rules block cross-UID reads).
        let anonMovies = [];
        if (currentUser && currentUser.isAnonymous) {
            try {
                const snap = await getDocs(collection(db, 'users', currentUser.uid, 'movies'));
                anonMovies = snap.docs.map(d => ({ id: d.id, data: d.data() }));
            } catch (_) { /* best effort */ }
        }

        // Detach old Firestore listener before UID changes to avoid
        // permission-denied errors on the orphaned anonymous path.
        if (unsubDecisions) { unsubDecisions(); unsubDecisions = null; }

        if (currentUser && currentUser.isAnonymous) {
            try {
                const result = await linkWithPopup(currentUser, googleProvider);
                currentUser = result.user;
                showToast('Signed in — your watchlist is now saved to your Google account');
            } catch (linkErr) {
                if (linkErr.code === 'auth/credential-already-in-use') {
                    const credential = GoogleAuthProvider.credentialFromError(linkErr);
                    if (credential) {
                        const result = await signInWithCredential(auth, credential);
                        currentUser = result.user;
                    } else {
                        const result = await signInWithPopup(auth, googleProvider);
                        currentUser = result.user;
                    }
                    // Merge anonymous movies into the Google account
                    await mergeAnonMovies(anonMovies, currentUser.uid);
                    showToast('Signed in as ' + (currentUser.displayName || currentUser.email || 'Google user'));
                } else if (linkErr.code === 'auth/popup-closed-by-user' || linkErr.code === 'auth/cancelled-popup-request') {
                    // User closed popup — stay anonymous, re-attach listener
                    listenToDecisions();
                    return;
                } else {
                    throw linkErr;
                }
            }
        } else {
            const result = await signInWithPopup(auth, googleProvider);
            currentUser = result.user;
            showToast('Signed in as ' + (currentUser.displayName || currentUser.email || 'Google user'));
        }
    } catch (err) {
        if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') {
            // User closed popup — do nothing
        } else {
            console.error('Google sign-in failed:', err);
            showToast('Sign-in failed. Please try again.');
        }
        // Re-attach listener if sign-in failed
        listenToDecisions();
    } finally {
        isGoogleSignInProgress = false;
    }
    updateAuthUI();
}

/**
 * Merge pre-captured anonymous movies into the Google user's collection.
 * Movies are read BEFORE switching users (while still anonymous) to avoid
 * Firestore permission-denied errors from cross-UID reads.
 */
async function mergeAnonMovies(anonMovies, googleUid) {
    if (!anonMovies.length || !googleUid) return;
    try {
        const googleSnap = await getDocs(collection(db, 'users', googleUid, 'movies'));
        const existingIds = new Set(googleSnap.docs.map(d => d.id));
        for (const movie of anonMovies) {
            if (!existingIds.has(movie.id)) {
                await setDoc(doc(db, 'users', googleUid, 'movies', movie.id), movie.data);
            }
        }
    } catch (err) {
        console.warn('Merge of anonymous data failed:', err);
    }
}

async function handleSignOut() {
    try {
        await signOut(auth);
        window.location.reload();
    } catch (err) {
        console.error('Sign-out failed:', err);
    }
}

function updateAuthUI() {
    const signInBtn = document.getElementById('btn-google-signin');
    const userInfo = document.getElementById('user-info');
    const userName = document.getElementById('user-name');
    const signOutBtn = document.getElementById('btn-signout');

    if (!signInBtn || !userInfo) return;

    if (currentUser && !currentUser.isAnonymous) {
        signInBtn.classList.add('hidden');
        userInfo.classList.remove('hidden');
        userName.textContent = currentUser.displayName || currentUser.email || 'Signed in';
    } else {
        signInBtn.classList.remove('hidden');
        userInfo.classList.add('hidden');
    }
}

/**
 * Try Google One Tap auto sign-in. Shows a small prompt in the corner
 * without requiring a user gesture. Falls back silently if GIS library
 * isn't loaded or client ID isn't configured.
 */
function tryGoogleOneTap() {
    if (!googleClientId || !window.google?.accounts?.id) return;
    if (currentUser && !currentUser.isAnonymous) return; // already signed in

    google.accounts.id.initialize({
        client_id: googleClientId,
        callback: handleOneTapResponse,
        auto_select: true,       // auto-sign-in for returning users
        cancel_on_tap_outside: true,
    });
    google.accounts.id.prompt();
}

async function handleOneTapResponse(response) {
    if (!response.credential) return;
    isGoogleSignInProgress = true;
    try {
        // Capture anonymous data before switching
        let anonMovies = [];
        if (currentUser && currentUser.isAnonymous) {
            try {
                const snap = await getDocs(collection(db, 'users', currentUser.uid, 'movies'));
                anonMovies = snap.docs.map(d => ({ id: d.id, data: d.data() }));
            } catch (_) { /* best effort */ }
            if (unsubDecisions) { unsubDecisions(); unsubDecisions = null; }
        }

        const credential = GoogleAuthProvider.credential(response.credential);
        const result = await signInWithCredential(auth, credential);
        currentUser = result.user;

        if (anonMovies.length) {
            await mergeAnonMovies(anonMovies, currentUser.uid);
        }

        updateAuthUI();
        showToast('Signed in as ' + (currentUser.displayName || currentUser.email || 'Google user'));
    } catch (err) {
        console.warn('One Tap sign-in failed:', err);
        listenToDecisions(); // re-attach if it was detached
    } finally {
        isGoogleSignInProgress = false;
    }
}

// ─── TMDB API ────────────────────────────────────────────────────────
function mediaKey(id, mediaType) {
    return mediaType === 'tv' ? `tv_${id}` : Number(id);
}

async function fetchGenres() {
    const [movieRes, tvRes] = await Promise.all([
        fetch(`${TMDB_BASE}/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-US`),
        fetch(`${TMDB_BASE}/genre/tv/list?api_key=${TMDB_API_KEY}&language=en-US`)
    ]);
    const [movieData, tvData] = await Promise.all([movieRes.json(), tvRes.json()]);
    [...(movieData.genres || []), ...(tvData.genres || [])].forEach(g => { genreMap[g.id] = g.name; });
}

async function fetchUpcoming(page = 1) {
    const url = `${TMDB_BASE}/movie/upcoming?api_key=${TMDB_API_KEY}&region=US&page=${page}`;
    const res = await fetch(url);
    const data = await res.json();
    theatricalTotalPages = data.total_pages || 1;
    // Tag each movie with its source
    return (data.results || []).map(m => ({ ...m, _source: 'theatrical' }));
}

async function fetchStreaming(page = 1) {
    const today = new Date().toISOString().split('T')[0];
    const url = `${TMDB_BASE}/discover/movie?api_key=${TMDB_API_KEY}`
        + `&with_watch_providers=${STREAMING_PROVIDERS}`
        + `&watch_region=US`
        + `&sort_by=primary_release_date.asc`
        + `&primary_release_date.gte=${today}`
        + `&page=${page}`;
    const res = await fetch(url);
    const data = await res.json();
    streamingTotalPages = data.total_pages || 1;
    return (data.results || []).map(m => ({ ...m, _source: 'streaming' }));
}

async function fetchSeries(page = 1) {
    const url = `${TMDB_BASE}/discover/tv?api_key=${TMDB_API_KEY}`
        + `&sort_by=popularity.desc`
        + `&watch_region=US`
        + `&with_original_language=en`
        + `&vote_count.gte=10`
        + `&page=${page}`;
    const res = await fetch(url);
    const data = await res.json();
    seriesTotalPages = data.total_pages || 1;
    return (data.results || []).map(m => ({
        ...m,
        title: m.name || m.title || '',
        release_date: m.first_air_date || '',
        _source: 'series',
        _mediaType: 'tv',
    }));
}

async function searchMovies(query, page = 1) {
    const url = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
    const res = await fetch(url);
    const data = await res.json();
    return (data.results || []).map(m => ({ ...m, _source: 'search' }));
}

async function searchSeries(query, page = 1) {
    const url = `${TMDB_BASE}/search/tv?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}&include_adult=false`;
    const res = await fetch(url);
    const data = await res.json();
    return (data.results || []).map(m => ({
        ...m,
        title: m.name || m.title || '',
        release_date: m.first_air_date || '',
        _source: 'search',
        _mediaType: 'tv',
    }));
}

/**
 * Strip leading articles ("The ", "A ", "An ") from a title for matching.
 */
function stripArticle(str) {
    return str.replace(/^(the|a|an)\s+/i, '').trim();
}

/**
 * Simple character-level similarity: longest common subsequence ratio.
 * Returns 0–1 where 1 = identical.
 */
function similarity(a, b) {
    a = a.toLowerCase();
    b = b.toLowerCase();
    if (a === b) return 1;
    if (b.includes(a) || a.includes(b)) return 0.9;
    // Compute overlap using bigrams
    const bigrams = (s) => {
        const set = new Set();
        for (let i = 0; i < s.length - 1; i++) set.add(s.slice(i, i + 2));
        return set;
    };
    const ba = bigrams(a);
    const bb = bigrams(b);
    let inter = 0;
    ba.forEach(bg => { if (bb.has(bg)) inter++; });
    return (2 * inter) / (ba.size + bb.size || 1);
}

/**
 * Score how well a query matches a movie title.
 * Higher = better match.
 */
function fuzzyScore(query, movie) {
    const q = query.toLowerCase().trim();
    const title = (movie.title || '').toLowerCase();
    const titleNoArticle = stripArticle(title);
    const qNoArticle = stripArticle(q);

    let score = 0;

    // Exact match — always rank first, far above any partial match
    if (title === q || titleNoArticle === qNoArticle) return 10000;

    // Title starts with query (partial)
    if (title.startsWith(q) || titleNoArticle.startsWith(qNoArticle)) score += 60;

    // Query is a substring of title
    if (title.includes(q) || titleNoArticle.includes(qNoArticle)) score += 40;

    // Word-level match — each query word found in title
    const qWords = qNoArticle.split(/\s+/).filter(Boolean);
    const titleWords = titleNoArticle.split(/\s+/);
    const matchedWords = qWords.filter(w => titleWords.some(t => t.startsWith(w) || similarity(w, t) > 0.7));
    score += (matchedWords.length / Math.max(qWords.length, 1)) * 30;

    // Bigram similarity (handles typos)
    score += similarity(qNoArticle, titleNoArticle) * 20;

    // Boost popular / well-rated movies slightly
    score += Math.min((movie.vote_count || 0) / 5000, 1) * 5;
    score += Math.min((movie.vote_average || 0) / 10, 1) * 3;

    return score;
}

/**
 * Search with fuzzy reranking. Primary TMDB search + optional article-stripped
 * secondary search merged and ranked by fuzzy score.
 */
async function smartSearch(query) {
    const stripped = stripArticle(query);
    const searchMovie = activeSource !== 'series';
    const searchTv    = activeSource === 'series' || activeSource === 'all';

    const searches = [];
    if (searchMovie) {
        searches.push(searchMovies(query));
        if (stripped !== query && stripped.length >= 2) searches.push(searchMovies(stripped));
    }
    if (searchTv) {
        searches.push(searchSeries(query));
        if (stripped !== query && stripped.length >= 2) searches.push(searchSeries(stripped));
    }

    const results = await Promise.all(searches);
    const merged = results.flat();

    // Deduplicate by compound key (movie/TV share numeric ID space on TMDB)
    const seen = new Set();
    const unique = merged.filter(m => {
        const key = mediaKey(m.id, m._mediaType);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });

    const scored = unique
        .map(m => ({ m, score: fuzzyScore(query, m) }))
        .filter(x => x.score > 5)
        .sort((a, b) => b.score - a.score);

    return scored.map(x => x.m);
}

async function fetchMovieDetails(tmdbId, mediaType = 'movie') {
    const cacheKey = mediaType === 'tv' ? `tv_${tmdbId}` : tmdbId;
    if (detailCache.has(cacheKey)) return detailCache.get(cacheKey);
    try {
        const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
        const url = `${TMDB_BASE}/${endpoint}/${tmdbId}?api_key=${TMDB_API_KEY}&language=en-US`;
        const res = await fetch(url);
        const data = await res.json();
        if (mediaType === 'tv') {
            data.title = data.name || data.title;
            data.release_date = data.first_air_date || '';
        }
        detailCache.set(cacheKey, data);
        return data;
    } catch {
        return null;
    }
}

async function fetchOmdbRatings(imdbId) {
    if (!omdbApiKey || !imdbId) return null;
    if (omdbCache.has(imdbId)) return omdbCache.get(imdbId);
    try {
        const url = `https://www.omdbapi.com/?apikey=${omdbApiKey}&i=${imdbId}`;
        const res = await fetch(url);
        const data = await res.json();
        if (data.Response === 'False') { omdbCache.set(imdbId, null); return null; }
        const ratings = {};
        if (data.imdbRating && data.imdbRating !== 'N/A') ratings.imdb = data.imdbRating;
        const rt = (data.Ratings || []).find(r => r.Source === 'Rotten Tomatoes');
        if (rt) ratings.rt = rt.Value;
        const mc = (data.Ratings || []).find(r => r.Source === 'Metacritic');
        if (mc) ratings.metacritic = mc.Value;
        const result = Object.keys(ratings).length ? ratings : null;
        omdbCache.set(imdbId, result);
        return result;
    } catch {
        return null;
    }
}

async function fetchWatchProviders(tmdbId, mediaType = 'movie') {
    const cacheKey = mediaType === 'tv' ? `tv_${tmdbId}` : tmdbId;
    if (providerCache.has(cacheKey)) return providerCache.get(cacheKey);
    try {
        const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
        const url = `${TMDB_BASE}/${endpoint}/${tmdbId}/watch/providers?api_key=${TMDB_API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        // Use US providers; fall back to empty
        const us = data.results?.US || {};
        const flatrate = (us.flatrate || []).map(p => ({
            id: p.provider_id,
            name: p.provider_name,
            logoPath: p.logo_path,
        }));
        providerCache.set(cacheKey, flatrate);
        return flatrate;
    } catch {
        providerCache.set(cacheKey, []);
        return [];
    }
}

async function fetchTrailer(tmdbId, mediaType = 'movie') {
    const cacheKey = mediaType === 'tv' ? `tv_${tmdbId}` : tmdbId;
    if (trailerCache.has(cacheKey)) return trailerCache.get(cacheKey);
    try {
        const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
        const url = `${TMDB_BASE}/${endpoint}/${tmdbId}/videos?api_key=${TMDB_API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        const videos = (data.results || []).filter(v => v.site === 'YouTube');

        // Priority: Official Trailer → any Trailer → Official Teaser → any Teaser
        const trailer =
            videos.find(v => v.type === 'Trailer' && v.official === true) ||
            videos.find(v => v.type === 'Trailer') ||
            videos.find(v => v.type === 'Teaser' && v.official === true) ||
            videos.find(v => v.type === 'Teaser') ||
            null;

        const ytUrl = trailer ? `https://www.youtube.com/watch?v=${trailer.key}` : null;
        trailerCache.set(cacheKey, ytUrl);
        return ytUrl;
    } catch {
        trailerCache.set(cacheKey, null);
        return null;
    }
}

async function fetchCredits(tmdbId, mediaType = 'movie') {
    const cacheKey = mediaType === 'tv' ? `tv_${tmdbId}` : tmdbId;
    if (castCache.has(cacheKey)) return castCache.get(cacheKey);
    try {
        const endpoint = mediaType === 'tv' ? 'tv' : 'movie';
        const url = `${TMDB_BASE}/${endpoint}/${tmdbId}/credits?api_key=${TMDB_API_KEY}`;
        const res = await fetch(url);
        const data = await res.json();
        const topCast = (data.cast || []).slice(0, 5).map(c => ({
            name: c.name,
            character: c.character,
            profilePath: c.profile_path
        }));
        const directors = (data.crew || [])
            .filter(c => c.job === 'Director')
            .map(c => c.name);
        const result = { cast: topCast, directors };
        castCache.set(cacheKey, result);
        return result;
    } catch {
        const fallback = { cast: [], directors: [] };
        castCache.set(cacheKey, fallback);
        return fallback;
    }
}

function getImageUrl(path, size = 'w500') {
    if (!path) return null;
    return `https://image.tmdb.org/t/p/${size}${path}`;
}

function getGenreNames(genreIds) {
    return (genreIds || []).map(id => genreMap[id]).filter(Boolean);
}

// ─── Firestore ───────────────────────────────────────────────────────
async function saveDecision(movie, status) {
    if (!currentUser) return;
    const docId = movie._mediaType === 'tv' ? `tv_${movie.id}` : String(movie.id);
    const movieRef = doc(db, 'users', currentUser.uid, 'movies', docId);
    await setDoc(movieRef, {
        tmdbId: movie.id,
        status: status,
        title: movie.title,
        posterPath: movie.poster_path,
        releaseDate: movie.release_date,
        overview: movie.overview || '',
        genres: getGenreNames(movie.genre_ids),
        popularity: movie.popularity || 0,
        voteAverage: movie.vote_average || 0,
        voteCount: movie.vote_count || 0,
        source: movie._source || 'theatrical',
        mediaType: movie._mediaType || 'movie',
        decidedAt: new Date().toISOString()
    });
}

let unsubDecisions = null;

function listenToDecisions() {
    // Detach previous listener if switching users
    if (unsubDecisions) { unsubDecisions(); unsubDecisions = null; }
    if (!currentUser) return;
    const moviesRef = collection(db, 'users', currentUser.uid, 'movies');
    unsubDecisions = onSnapshot(moviesRef, (snapshot) => {
        userMovies.clear();
        snapshot.forEach((d) => {
            const data = d.data();
            userMovies.set(mediaKey(data.tmdbId, data.mediaType), data);
        });
        renderWatchlist();
        renderSeen();
        renderDismissed();
        updateTabBadges();
        checkReleaseNotifications();
    });
}

// ─── Discover feed ───────────────────────────────────────────────────
function getUndecidedMovies(movies) {
    return movies.filter(m => !userMovies.has(mediaKey(m.id, m._mediaType)));
}

/**
 * Filter out rereleases — movies whose original release date is more than
 * 2 years before today. TMDB's upcoming endpoint returns re-releases of
 * classic films that clutter the discover feed.
 */
function filterRereleases(movies) {
    const twoYearsAgo = new Date();
    twoYearsAgo.setFullYear(twoYearsAgo.getFullYear() - 2);
    const cutoff = twoYearsAgo.toISOString().split('T')[0];
    return movies.filter(m => {
        if (m._mediaType === 'tv') return true; // TV series are ongoing — never filter by air date
        if (!m.release_date) return true;
        return m.release_date >= cutoff;
    });
}

function calculateHypeScore(movie) {
    const popularity = movie.popularity || 0;
    const voteCount = movie.vote_count || 0;

    // Recency bonus: movies releasing within 30 days score higher
    let recencyBonus = 50; // default for movies with no date or far out
    if (movie.release_date) {
        const now = Date.now();
        const release = new Date(movie.release_date).getTime();
        const daysUntil = (release - now) / 86400000;
        if (daysUntil <= 0) recencyBonus = 100;       // already released
        else if (daysUntil <= 30) recencyBonus = 100 - (daysUntil / 30) * 100;
        else recencyBonus = 0;
    }

    // Normalize: popularity typically 0–500+, voteCount 0–10000+
    return (Math.min(popularity, 500) / 500) * 40
         + (recencyBonus / 100) * 40
         + (Math.min(voteCount, 5000) / 5000) * 20;
}

function sortDiscoverMovies(movies, sortBy) {
    const sorted = [...movies];
    switch (sortBy) {
        case 'relevance':
            sorted.sort((a, b) => calculateHypeScore(b) - calculateHypeScore(a));
            break;
        case 'release-date':
            sorted.sort((a, b) => {
                const da = a.release_date || '9999';
                const db = b.release_date || '9999';
                return da.localeCompare(db);
            });
            break;
        case 'rating':
            sorted.sort((a, b) => (b.vote_average || 0) - (a.vote_average || 0));
            break;
        case 'popularity':
            sorted.sort((a, b) => (b.popularity || 0) - (a.popularity || 0));
            break;
    }
    return sorted;
}

async function loadMoreMovies() {
    const gen = loadGeneration;
    isLoading = true;
    try {
        let newMovies = [];

        if (activeSource === 'theatrical' || activeSource === 'all') {
            if (theatricalPage <= theatricalTotalPages) {
                const theatrical = await fetchUpcoming(theatricalPage);
                if (gen !== loadGeneration) return; // filter changed mid-fetch
                newMovies.push(...theatrical);
                theatricalPage++;
            }
        }

        if (activeSource === 'streaming' || activeSource === 'all') {
            if (streamingPage <= streamingTotalPages) {
                const streaming = await fetchStreaming(streamingPage);
                if (gen !== loadGeneration) return; // filter changed mid-fetch
                newMovies.push(...streaming);
                streamingPage++;
            }
        }

        if (activeSource === 'series' || activeSource === 'all') {
            if (seriesPage <= seriesTotalPages) {
                const series = await fetchSeries(seriesPage);
                if (gen !== loadGeneration) return;
                newMovies.push(...series);
                seriesPage++;
            }
        }

        // Deduplicate by compound key (same numeric id can appear in both movie and TV namespaces)
        const existingKeys = new Set(currentMovies.map(m => mediaKey(m.id, m._mediaType)));
        newMovies = newMovies.filter(m => !existingKeys.has(mediaKey(m.id, m._mediaType)));

        const fresh = filterRereleases(newMovies);
        const undecided = getUndecidedMovies(fresh);
        currentMovies.push(...undecided);

        // Sort remaining unseen movies (preserve already-viewed order)
        const seen = currentMovies.slice(0, currentIndex);
        const unseen = currentMovies.slice(currentIndex);
        currentMovies = [...seen, ...sortDiscoverMovies(unseen, activeSortBy)];
    } catch (err) {
        console.error('Failed to fetch movies:', err);
    }
    isLoading = false;
}

function updateDiscoverCounter() {
    if (isSearchMode) return; // Search mode manages its own counter
    const remaining = currentMovies.slice(currentIndex).filter(m => !userMovies.has(mediaKey(m.id, m._mediaType))).length;
    if (remaining > 0) {
        const label = remaining !== 1 ? 'titles' : 'title';
        discoverCounter.textContent = `${remaining} ${label} to discover`;
        discoverCounter.classList.remove('hidden');
    } else {
        discoverCounter.classList.add('hidden');
    }
}

function showCurrentCard() {
    cardStack.innerHTML = '';
    updateDiscoverCounter();

    // Re-append skipped movies when queue is exhausted
    if (currentIndex >= currentMovies.length && skippedQueue.length > 0) {
        currentMovies.push(...skippedQueue);
        skippedQueue = [];
        showToast('Showing skipped movies again');
    }

    // Skip past any movies that have been decided on since they were loaded
    while (currentIndex < currentMovies.length && userMovies.has(mediaKey(currentMovies[currentIndex].id, currentMovies[currentIndex]._mediaType))) {
        currentIndex++;
    }

    if (currentIndex >= currentMovies.length) {
        const msg = isSearchMode
            ? 'No results found.'
            : 'No more movies to discover!';
        const hint = isSearchMode
            ? 'Try a different search term.'
            : 'Check back later for new releases.';
        cardStack.innerHTML = `<div class="empty-state"><p>${msg}</p><p class="hint">${hint}</p></div>`;
        return;
    }

    // Prefetch next page when 3 cards from the end (not in search mode)
    if (!isSearchMode && currentIndex >= currentMovies.length - 3) {
        loadMoreMovies().then(updateDiscoverCounter);
    }

    const movie = currentMovies[currentIndex];
    const genres = getGenreNames(movie.genre_ids);
    const posterUrl = getImageUrl(movie.poster_path);
    const rating = movie.vote_average ? movie.vote_average.toFixed(1) : '—';
    const popularity = movie.popularity ? Math.round(movie.popularity) : 0;
    const releaseFormatted = formatDate(movie.release_date);
    const overviewFull = movie.overview || '';
    const overviewShort = truncate(overviewFull, 120);
    const needsTruncation = overviewFull.length > 120;
    const sourceBadge = movie._source === 'streaming'
        ? '<span class="source-badge streaming">Streaming</span>'
        : movie._source === 'series'
            ? '<span class="source-badge series">Series</span>'
            : movie._source === 'search'
                ? ''
                : '<span class="source-badge theatrical">Theatrical</span>';

    const card = document.createElement('div');
    card.className = 'movie-card';
    card.innerHTML = `
        <div class="swipe-overlay overlay-interested">INTERESTED</div>
        <div class="swipe-overlay overlay-nope">NOPE</div>
        <div class="swipe-overlay overlay-skip">SKIP</div>
        ${posterUrl
            ? `<img src="${posterUrl}" alt="${movie.title}" draggable="false">`
            : '<div class="no-poster">No Poster</div>'}
        <div class="card-info">
            <div class="card-title-row">
                <h3>${movie.title}</h3>
                ${sourceBadge}
            </div>
            <p class="release-date">${releaseFormatted}</p>
            <div class="scores">
                <span class="score-badge rating" title="Click for info">★ ${rating} <span class="score-source-label">TMDb</span></span>
                <span class="score-badge popularity" title="Click for info">🔥 ${popularity}</span>
            </div>
            <div class="card-ext-scores" id="card-ext-scores-${movie.id}"></div>
            ${genres.length > 0
                ? `<div class="genre-badges">${genres.map(g => `<span class="genre-badge">${g}</span>`).join('')}</div>`
                : ''}
            <div class="provider-row" id="provider-row-${movie.id}"></div>
            <p class="director-line" id="director-line-${movie.id}"></p>
            <div class="cast-row" id="cast-row-${movie.id}">
                <span class="cast-loading">Loading cast…</span>
            </div>
            <p class="overview ${needsTruncation ? 'truncated' : ''}"
               data-full="${escapeAttr(overviewFull)}"
               data-short="${escapeAttr(overviewShort)}">${overviewShort}</p>
            <div class="card-actions">
                <a class="trailer-link loading" id="trailer-link-${movie.id}" href="#" target="_blank" rel="noopener">
                    ▶ Trailer
                </a>
            </div>
        </div>
    `;
    cardStack.appendChild(card);

    // Overview expand/collapse
    const overviewEl = card.querySelector('.overview');
    if (needsTruncation) {
        overviewEl.addEventListener('click', (e) => {
            e.stopPropagation();
            const isExpanded = overviewEl.classList.contains('expanded');
            if (isExpanded) {
                overviewEl.textContent = overviewEl.dataset.short;
                overviewEl.classList.remove('expanded');
                overviewEl.classList.add('truncated');
            } else {
                overviewEl.textContent = overviewEl.dataset.full;
                overviewEl.classList.add('expanded');
                overviewEl.classList.remove('truncated');
            }
        });
    }

    // Fetch credits (director + cast) async
    fetchCredits(movie.id, movie._mediaType || 'movie').then(({ cast, directors }) => {
        // Render director
        const directorLine = document.getElementById(`director-line-${movie.id}`);
        if (directorLine && directors.length > 0) {
            directorLine.innerHTML = `🎬 <span class="director-label">Directed by</span> ${directors.join(', ')}`;
        }

        // Render cast
        const castRow = document.getElementById(`cast-row-${movie.id}`);
        if (!castRow) return;
        if (cast.length === 0) {
            castRow.innerHTML = '';
            return;
        }
        castRow.innerHTML = cast.map(c => {
            const photo = c.profilePath
                ? `<img src="${getImageUrl(c.profilePath, 'w45')}" alt="${c.name}" class="cast-photo">`
                : '<div class="cast-photo cast-no-photo">?</div>';
            return `<div class="cast-member" title="${c.name} as ${c.character}">
                ${photo}
                <div class="cast-text">
                    <span class="cast-name">${c.name}</span>
                    <span class="cast-character">${c.character || ''}</span>
                </div>
            </div>`;
        }).join('');
    });

    // Fetch streaming providers async
    fetchWatchProviders(movie.id, movie._mediaType || 'movie').then(providers => {
        const provRow = document.getElementById(`provider-row-${movie.id}`);
        if (!provRow || providers.length === 0) return;
        provRow.innerHTML = providers.slice(0, 5).map(p =>
            `<img src="https://image.tmdb.org/t/p/original${p.logoPath}" alt="${p.name}" title="${p.name}" class="provider-logo">`
        ).join('');
    });

    // Fetch trailer async
    fetchTrailer(movie.id, movie._mediaType || 'movie').then(ytUrl => {
        const link = document.getElementById(`trailer-link-${movie.id}`);
        if (!link) return;
        link.classList.remove('loading');
        if (ytUrl) {
            link.href = ytUrl;
            link.classList.add('available');
        } else {
            link.classList.add('unavailable');
            link.textContent = '▶ No trailer';
            link.removeAttribute('href');
            link.style.pointerEvents = 'none';
        }
    });

    // Fetch OMDb scores async (IMDb + RT + Metacritic) for the card
    if (omdbApiKey) {
        fetchMovieDetails(movie.id, movie._mediaType || 'movie').then(details => {
            if (!details?.imdb_id) return;
            return fetchOmdbRatings(details.imdb_id).then(ratings => {
                const el = document.getElementById(`card-ext-scores-${movie.id}`);
                if (!el || !ratings) return;
                let html = '';
                if (ratings.imdb) html += `<span class="score-badge imdb small" title="Click for info">IMDb ${ratings.imdb}</span>`;
                if (ratings.rt)   html += `<span class="score-badge rt small" title="Click for info">🍅 ${ratings.rt}</span>`;
                if (ratings.metacritic) html += `<span class="score-badge mc small" title="Click for info">MC ${ratings.metacritic}</span>`;
                if (html) el.innerHTML = html;
            });
        });
    }

    setupSwipeHandlers(card);

    // Tap on card poster opens detail (only if no swipe occurred)
    let cardTapStart = null;
    card.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.cast-row, .genre-badges, a, button, .overview, .card-actions, .scores, .card-ext-scores')) return;
        cardTapStart = { x: e.clientX, y: e.clientY, time: Date.now() };
    });
    card.addEventListener('pointerup', (e) => {
        if (!cardTapStart) return;
        const dx = Math.abs(e.clientX - cardTapStart.x);
        const dy = Math.abs(e.clientY - cardTapStart.y);
        const dt = Date.now() - cardTapStart.time;
        cardTapStart = null;
        // Tap: minimal movement and quick
        if (dx < 10 && dy < 10 && dt < 300) {
            openDetail(movie.id, movie._mediaType || 'movie');
        }
    });

    // Prevent cast-row touch events from triggering card swipe
    const castRowEl = card.querySelector('.cast-row');
    if (castRowEl) {
        castRowEl.addEventListener('touchstart', (e) => e.stopPropagation(), { passive: true });
        castRowEl.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
    }
}

// ─── Movie detail overlay ───────────────────────────────────────────
async function openDetail(tmdbId, mediaType = 'movie') {
    const overlay = document.getElementById('movie-detail');
    const content = document.getElementById('detail-content');
    content.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';
    overlay.classList.remove('hidden');
    history.pushState({ detail: true }, '');

    // Fetch full details, credits, providers, and trailer in parallel
    const [details, credits, providers, trailerUrl] = await Promise.all([
        fetchMovieDetails(tmdbId, mediaType),
        fetchCredits(tmdbId, mediaType),
        fetchWatchProviders(tmdbId, mediaType),
        fetchTrailer(tmdbId, mediaType),
    ]);

    if (!details) {
        content.innerHTML = '<div class="empty-state"><p>Could not load movie details.</p></div>';
        return;
    }

    const posterUrl = getImageUrl(details.poster_path);
    const genres = (details.genres || []).map(g => g.name);
    const rating = details.vote_average ? details.vote_average.toFixed(1) : '—';
    const voteCount = details.vote_count || 0;
    const voteCountStr = voteCount >= 1000 ? `${(voteCount / 1000).toFixed(0)}K` : String(voteCount);
    const popularity = details.popularity ? Math.round(details.popularity) : 0;
    const runtime = details.runtime ? `${Math.floor(details.runtime / 60)}h ${details.runtime % 60}m` : '';
    const releaseFormatted = formatDate(details.release_date);
    const directors = credits.directors || [];
    const cast = credits.cast || [];
    const overview = details.overview || 'No overview available.';
    const imdbId = details.imdb_id || (mediaType === 'tv' ? details.external_ids?.imdb_id : null) || null;

    // Determine movie status for action buttons
    const movieData = userMovies.get(mediaKey(tmdbId, mediaType));
    const status = movieData ? movieData.status : null;

    let actionsHtml = '';
    if (status === 'interested') {
        actionsHtml = `
            <button class="detail-action-btn detail-btn-seen" data-tmdb-id="${tmdbId}">✓ Mark as Seen</button>
            <button class="detail-action-btn detail-btn-dismiss" data-tmdb-id="${tmdbId}">✕ Remove</button>`;
    } else if (status === 'seen') {
        const ratingLabel = movieData.rating ? `★ ${movieData.rating}/10` : 'Unrated';
        actionsHtml = `
            <p class="detail-seen-info">${ratingLabel}</p>
            <button class="detail-action-btn detail-btn-edit-rating" data-tmdb-id="${tmdbId}">✏ Edit Rating</button>`;
    } else if (status === 'dismissed') {
        actionsHtml = `<button class="detail-action-btn detail-btn-restore" data-tmdb-id="${tmdbId}">↩ Restore to Watchlist</button>`;
    } else {
        actionsHtml = `
            <button class="detail-action-btn detail-btn-add" data-tmdb-id="${tmdbId}">✓ Add to Watchlist</button>
            <button class="detail-action-btn detail-btn-dismiss" data-tmdb-id="${tmdbId}">✕ Dismiss</button>`;
    }

    // Prominent score display
    const scoreHtml = rating !== '—'
        ? `<div class="detail-score">
               <span class="detail-score-number">★ ${rating}</span>
               <span class="detail-score-denom">/10</span>
               ${voteCount > 0 ? `<span class="detail-score-votes">(${voteCountStr} votes)</span>` : ''}
           </div>
           <p class="detail-score-label">TMDb User Rating</p>`
        : '';

    // External scores row: IMDB link always (if we have the ID), OMDb scores async
    const extScoresId = `detail-ext-scores-${tmdbId}`;
    const imdbLinkId = `detail-imdb-link-${tmdbId}`;
    const showExtRow = imdbId || omdbApiKey;
    const extScoresHtml = showExtRow
        ? `<div id="${extScoresId}" class="detail-external-scores">
               ${imdbId ? `<a id="${imdbLinkId}" class="detail-ext-score imdb-link" href="https://www.imdb.com/title/${imdbId}/" target="_blank" rel="noopener">IMDb ↗</a>` : ''}
               ${omdbApiKey ? '<span class="detail-scores-loading">…</span>' : ''}
           </div>`
        : '';

    content.innerHTML = `
        ${posterUrl ? `<img src="${posterUrl}" alt="${details.title}" class="detail-poster">` : ''}
        <div class="detail-info">
            <h2 class="detail-title">${details.title} ${details.release_date ? `<span class="detail-year">(${details.release_date.slice(0, 4)})</span>` : ''}</h2>
            ${scoreHtml}
            ${extScoresHtml}
            <div class="detail-meta">
                <span class="score-badge popularity" title="Click for info">🔥 ${popularity}</span>
                ${runtime ? `<span class="detail-runtime">${runtime}</span>` : ''}
            </div>
            <p class="release-date">${releaseFormatted}</p>
            ${genres.length ? `<div class="genre-badges">${genres.map(g => `<span class="genre-badge">${g}</span>`).join('')}</div>` : ''}
            ${directors.length ? `<p class="director-line">🎬 <span class="director-label">Directed by</span> ${directors.join(', ')}</p>` : ''}
            ${providers.length ? `
                <div class="detail-section">
                    <h4 class="detail-section-title">Available On</h4>
                    <div class="detail-providers">
                        ${providers.map(p => `
                            <div class="detail-provider">
                                <img src="https://image.tmdb.org/t/p/original${p.logoPath}" alt="${p.name}" class="provider-logo">
                                <span class="detail-provider-name">${p.name}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            ` : ''}
            <div class="detail-section">
                <h4 class="detail-section-title">Overview</h4>
                <p class="detail-overview">${overview}</p>
            </div>
            ${cast.length ? `
                <div class="detail-section">
                    <h4 class="detail-section-title">Cast</h4>
                    <div class="detail-cast">
                        ${cast.map(c => {
                            const photo = c.profilePath
                                ? `<img src="${getImageUrl(c.profilePath, 'w185')}" alt="${c.name}" class="detail-cast-photo">`
                                : '<div class="detail-cast-photo cast-no-photo">?</div>';
                            return `<div class="detail-cast-member">
                                ${photo}
                                <div>
                                    <span class="cast-name">${c.name}</span>
                                    <span class="cast-character">${c.character || ''}</span>
                                </div>
                            </div>`;
                        }).join('')}
                    </div>
                </div>
            ` : ''}
            ${trailerUrl ? `<a class="detail-trailer-btn" href="${trailerUrl}" target="_blank" rel="noopener">▶ Watch Trailer</a>` : ''}
            <div class="detail-actions">${actionsHtml}</div>
        </div>
    `;

    // Wire up action buttons
    const docId = mediaType === 'tv' ? `tv_${tmdbId}` : String(tmdbId);
    const addBtn = content.querySelector('.detail-btn-add');
    if (addBtn) addBtn.addEventListener('click', () => {
        const movie = currentMovies.find(m => m.id === Number(tmdbId) && (m._mediaType || 'movie') === mediaType) || details;
        if (!movie._mediaType) movie._mediaType = mediaType;
        saveDecision(movie, 'interested');
        closeDetail();
    });
    const dismissBtn = content.querySelector('.detail-btn-dismiss');
    if (dismissBtn) dismissBtn.addEventListener('click', async () => {
        if (movieData) {
            const movieRef = doc(db, 'users', currentUser.uid, 'movies', docId);
            await setDoc(movieRef, { ...movieData, status: 'dismissed', decidedAt: new Date().toISOString() });
            showToast(`Moved "${details.title}" to dismissed`);
        } else {
            const movie = currentMovies.find(m => m.id === Number(tmdbId) && (m._mediaType || 'movie') === mediaType) || details;
            if (!movie._mediaType) movie._mediaType = mediaType;
            saveDecision(movie, 'dismissed');
        }
        closeDetail();
    });
    const seenBtn = content.querySelector('.detail-btn-seen');
    if (seenBtn) seenBtn.addEventListener('click', () => {
        openRatingModal(mediaKey(tmdbId, mediaType));
        closeDetail();
    });
    const restoreBtn = content.querySelector('.detail-btn-restore');
    if (restoreBtn) restoreBtn.addEventListener('click', async () => {
        if (movieData) {
            const movieRef = doc(db, 'users', currentUser.uid, 'movies', docId);
            await setDoc(movieRef, { ...movieData, status: 'interested', decidedAt: new Date().toISOString() });
            showToast(`Restored "${details.title}" to watchlist ✓`);
        }
        closeDetail();
    });
    const editRatingBtn = content.querySelector('.detail-btn-edit-rating');
    if (editRatingBtn) editRatingBtn.addEventListener('click', () => {
        openRatingModal(mediaKey(tmdbId, mediaType), true);
    });

    // Async: fetch OMDb scores (IMDb + Rotten Tomatoes + Metacritic) and update the row
    if (omdbApiKey && imdbId) {
        fetchOmdbRatings(imdbId).then(ratings => {
            const el = document.getElementById(extScoresId);
            if (!el) return; // overlay was closed
            const loading = el.querySelector('.detail-scores-loading');
            if (loading) loading.remove();
            if (ratings) {
                // Enrich the existing IMDb link with the actual score
                if (ratings.imdb) {
                    const imdbLink = document.getElementById(imdbLinkId);
                    if (imdbLink) imdbLink.textContent = `IMDb ${ratings.imdb} ↗`;
                }
                if (ratings.rt) {
                    const badge = document.createElement('span');
                    badge.className = 'detail-ext-score rt-score';
                    badge.textContent = `🍅 ${ratings.rt}`;
                    el.appendChild(badge);
                }
                if (ratings.metacritic) {
                    const badge = document.createElement('span');
                    badge.className = 'detail-ext-score metacritic-score';
                    badge.textContent = `MC ${ratings.metacritic}`;
                    el.appendChild(badge);
                }
            }
        });
    }
}

function closeDetail() {
    const overlay = document.getElementById('movie-detail');
    if (overlay.classList.contains('hidden')) return;
    overlay.classList.add('hidden');
    if (history.state && history.state.detail) {
        history.back();
    }
}

document.getElementById('detail-back').addEventListener('click', closeDetail);

// Browser back button closes detail overlay
window.addEventListener('popstate', () => {
    const overlay = document.getElementById('movie-detail');
    if (!overlay.classList.contains('hidden')) {
        overlay.classList.add('hidden');
    }
});

// ─── Search ──────────────────────────────────────────────────────────
const searchResults = document.getElementById('search-results');

// ─── Recent searches ─────────────────────────────────────────────────
const RECENT_KEY = 'mt-recent-searches';
const MAX_RECENT = 8;

function getRecentSearches() {
    try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}

function saveRecentSearch(query) {
    const list = getRecentSearches().filter(q => q.toLowerCase() !== query.toLowerCase());
    list.unshift(query);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
}

function showRecentSearches() {
    const list = getRecentSearches();
    if (list.length === 0) return;
    hideRecentSearches();
    const panel = document.createElement('div');
    panel.id = 'recent-searches-panel';
    panel.className = 'recent-searches';
    panel.innerHTML = `
        <div class="recent-searches-header">
            <span class="recent-searches-label">Recent</span>
            <button class="recent-searches-clear">Clear all</button>
        </div>
        <div class="recent-searches-tags">
            ${list.map(q => `<button class="recent-search-tag">${q}</button>`).join('')}
        </div>`;
    document.querySelector('#view-discover .search-bar').insertAdjacentElement('afterend', panel);

    panel.querySelector('.recent-searches-clear').addEventListener('click', e => {
        e.stopPropagation();
        localStorage.removeItem(RECENT_KEY);
        panel.remove();
    });
    panel.querySelectorAll('.recent-search-tag').forEach(btn => {
        btn.addEventListener('click', () => {
            searchInput.value = btn.textContent;
            searchClear.classList.remove('hidden');
            hideRecentSearches();
            if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
            enterSearchMode(btn.textContent);
        });
    });
}

function hideRecentSearches() {
    document.getElementById('recent-searches-panel')?.remove();
}

function setupSearch() {
    searchInput.addEventListener('focus', () => {
        if (!searchInput.value.trim()) showRecentSearches();
    });

    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim();
        searchClear.classList.toggle('hidden', query.length === 0);
        hideRecentSearches();

        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

        if (query.length === 0) {
            exitSearchMode();
            return;
        }

        searchDebounceTimer = setTimeout(() => {
            enterSearchMode(query);
        }, 400);
    });

    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.add('hidden');
        hideRecentSearches();
        exitSearchMode();
    });

    // Close panel when clicking outside
    document.addEventListener('click', e => {
        if (!e.target.closest('#recent-searches-panel') && e.target !== searchInput) {
            hideRecentSearches();
        }
    });
}

async function enterSearchMode(query) {
    isSearchMode = true;
    currentMovies = [];
    currentIndex = 0;
    saveRecentSearch(query);

    // Hide card stack UI, show search results list
    cardStack.classList.add('hidden');
    document.querySelector('.swipe-buttons').classList.add('hidden');
    document.querySelector('.swipe-hint').classList.add('hidden');
    searchResults.classList.remove('hidden');
    searchResults.innerHTML = '<div class="loading"><div class="spinner"></div><p>Searching…</p></div>';

    try {
        const results = await smartSearch(query);
        currentMovies = results;
        renderSearchResults();
    } catch (err) {
        console.error('Search failed:', err);
        searchResults.innerHTML = '<div class="empty-state"><p>Search failed.</p><p class="hint">Please try again.</p></div>';
    }
}

function renderSearchResults() {
    const undecided = currentMovies.filter(m => !userMovies.has(mediaKey(m.id, m._mediaType)));
    const decided   = currentMovies.filter(m =>  userMovies.has(mediaKey(m.id, m._mediaType)));

    if (undecided.length === 0 && decided.length === 0) {
        searchResults.innerHTML = '<div class="empty-state"><p>No results found.</p><p class="hint">Try a different search term.</p></div>';
        discoverCounter.textContent = '0 results';
        discoverCounter.classList.remove('hidden');
        return;
    }

    const counterParts = [];
    if (undecided.length > 0) counterParts.push(`${undecided.length} new`);
    if (decided.length > 0)   counterParts.push(`${decided.length} in lists`);
    discoverCounter.textContent = counterParts.join(' · ');
    discoverCounter.classList.remove('hidden');

    searchResults.innerHTML = '';

    if (undecided.length > 0) {
        const hint = document.createElement('p');
        hint.className = 'search-swipe-hint';
        hint.textContent = 'Swipe right to add, left to dismiss';
        searchResults.appendChild(hint);
        undecided.forEach(movie => searchResults.appendChild(createSearchResultItem(movie)));
    } else {
        const msg = document.createElement('p');
        msg.className = 'search-swipe-hint';
        msg.textContent = 'Already in your lists — see below';
        searchResults.appendChild(msg);
    }

    if (decided.length > 0) {
        const header = document.createElement('p');
        header.className = 'sr-decided-header';
        header.textContent = 'Already in your lists';
        searchResults.appendChild(header);
        decided.forEach(movie => {
            const data = userMovies.get(mediaKey(movie.id, movie._mediaType));
            searchResults.appendChild(createDecidedResultItem(movie, data));
        });
    }
}

function createDecidedResultItem(movie, data) {
    const posterUrl = getImageUrl(movie.poster_path, 'w92');
    const genres = getGenreNames(movie.genre_ids);
    const releaseFormatted = formatDate(movie.release_date);
    const statusMap = { interested: 'Watchlist', seen: 'Seen', dismissed: 'Dismissed' };
    const statusLabel = statusMap[data?.status] || '';

    const item = document.createElement('div');
    item.className = 'sr-decided-item';
    item.innerHTML = `
        ${posterUrl
            ? `<img src="${posterUrl}" alt="${movie.title}" class="sr-poster">`
            : '<div class="sr-poster sr-no-poster">?</div>'}
        <div class="sr-info">
            <h4 class="sr-title">${movie.title}</h4>
            <p class="sr-date">${releaseFormatted}</p>
            <div class="sr-meta">
                <span class="score-badge rating small">★ ${movie.vote_average ? movie.vote_average.toFixed(1) : '—'}</span>
                ${genres.slice(0, 2).map(g => `<span class="genre-badge small">${g}</span>`).join('')}
            </div>
        </div>
        <span class="sr-decided-status status-${data?.status}">${statusLabel}</span>
    `;
    item.addEventListener('click', () => openDetail(movie.id, movie._mediaType || 'movie'));
    return item;
}

function createSearchResultItem(movie) {
    const posterUrl = getImageUrl(movie.poster_path, 'w92');
    const rating = movie.vote_average ? movie.vote_average.toFixed(1) : '—';
    const genres = getGenreNames(movie.genre_ids);
    const releaseFormatted = formatDate(movie.release_date);

    const wrap = document.createElement('div');
    wrap.className = 'search-result-item-wrap';
    wrap.dataset.movieId = movie.id;

    // Action panels revealed behind the sliding item (Gmail/Outlook style)
    const actionRight = document.createElement('div');
    actionRight.className = 'sr-action sr-action-right';
    actionRight.innerHTML = '<div class="sr-action-icon">✓<span class="sr-action-label">Watchlist</span></div>';

    const actionLeft = document.createElement('div');
    actionLeft.className = 'sr-action sr-action-left';
    actionLeft.innerHTML = '<div class="sr-action-icon">✕<span class="sr-action-label">Dismiss</span></div>';

    wrap.appendChild(actionRight);
    wrap.appendChild(actionLeft);

    const item = document.createElement('div');
    item.className = 'search-result-item';

    item.innerHTML = `
        <div class="sr-content">
            ${posterUrl
                ? `<img src="${posterUrl}" alt="${movie.title}" class="sr-poster">`
                : '<div class="sr-poster sr-no-poster">?</div>'}
            <div class="sr-info">
                <h4 class="sr-title">${movie.title}</h4>
                <p class="sr-date">${releaseFormatted}</p>
                <div class="sr-meta">
                    <span class="score-badge rating small">★ ${rating}</span>
                    ${genres.slice(0, 2).map(g => `<span class="genre-badge small">${g}</span>`).join('')}
                </div>
            </div>
        </div>
    `;

    wrap.appendChild(item);
    setupSearchItemSwipe(wrap, item, movie);

    // Tap (no swipe) opens detail view
    let srTapStart = null;
    item.addEventListener('pointerdown', (e) => {
        if (e.target.closest('a, button')) return;
        srTapStart = { x: e.clientX, y: e.clientY, time: Date.now() };
    });
    item.addEventListener('pointerup', (e) => {
        if (!srTapStart) return;
        const dx = Math.abs(e.clientX - srTapStart.x);
        const dy = Math.abs(e.clientY - srTapStart.y);
        const dt = Date.now() - srTapStart.time;
        srTapStart = null;
        if (dx < 10 && dy < 10 && dt < 300) {
            openDetail(movie.id, movie._mediaType || 'movie');
        }
    });

    return wrap;
}

function setupSearchItemSwipe(wrap, item, movie) {
    let startX = 0;
    let startY = 0;
    let deltaX = 0;
    let isTracking = false;
    let directionLocked = false; // true once we know horizontal vs vertical
    const THRESHOLD = 80;
    const DIRECTION_LOCK = 6; // px before we decide direction
    const actionRight = wrap.querySelector('.sr-action-right');
    const actionLeft = wrap.querySelector('.sr-action-left');

    function onStart(x, y) {
        startX = x;
        startY = y;
        deltaX = 0;
        isTracking = false;
        directionLocked = false;
        item.style.transition = 'none';
        actionRight.style.opacity = 0;
        actionLeft.style.opacity = 0;
    }

    function onMove(x, y) {
        const dy = Math.abs(y - startY);
        const dx = Math.abs(x - startX);

        // Lock direction once moved enough
        if (!directionLocked && (dx > DIRECTION_LOCK || dy > DIRECTION_LOCK)) {
            directionLocked = true;
            isTracking = dx > dy; // only swipe if more horizontal than vertical
        }

        if (!isTracking) return;
        deltaX = x - startX;
        item.style.transform = `translateX(${deltaX}px)`;

        const progress = Math.min(Math.abs(deltaX) / THRESHOLD, 1);
        if (deltaX > 0) {
            // Swiping right → show green "Watchlist" panel on left side
            actionRight.style.opacity = 0.4 + progress * 0.6;
            actionLeft.style.opacity = 0;
        } else {
            // Swiping left → show red "Dismiss" panel on right side
            actionLeft.style.opacity = 0.4 + progress * 0.6;
            actionRight.style.opacity = 0;
        }
    }

    function onEnd() {
        if (!isTracking) return;
        isTracking = false;

        if (Math.abs(deltaX) > THRESHOLD) {
            const status = deltaX > 0 ? 'interested' : 'dismissed';
            const direction = deltaX > 0 ? 1 : -1;
            item.style.transition = 'transform 0.3s ease, opacity 0.3s ease';
            item.style.transform = `translateX(${direction * 400}px)`;
            item.style.opacity = '0';

            saveDecision(movie, status).then(() => {
                showToast(status === 'interested'
                    ? `Added "${movie.title}" to watchlist ✓`
                    : `Dismissed "${movie.title}"`);
            });

            setTimeout(() => {
                wrap.style.height = wrap.offsetHeight + 'px';
                requestAnimationFrame(() => {
                    wrap.style.transition = 'height 0.25s ease, margin 0.25s ease, padding 0.25s ease';
                    wrap.style.height = '0';
                    wrap.style.marginBottom = '0';
                    wrap.style.overflow = 'hidden';
                    setTimeout(() => {
                        wrap.remove();
                        const remaining = searchResults.querySelectorAll('.search-result-item-wrap').length;
                        discoverCounter.textContent = `${remaining} result${remaining !== 1 ? 's' : ''}`;
                        if (remaining === 0) {
                            searchResults.innerHTML = '<div class="empty-state"><p>All results sorted!</p><p class="hint">Search for more or clear the search.</p></div>';
                        }
                    }, 250);
                });
            }, 300);
        } else {
            item.style.transition = 'transform 0.2s ease';
            item.style.transform = '';
            actionRight.style.opacity = 0;
            actionLeft.style.opacity = 0;
        }
    }

    wrap.addEventListener('touchstart', (e) => {
        if (e.target.closest('a, button')) return;
        onStart(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });

    wrap.addEventListener('touchmove', (e) => {
        onMove(e.touches[0].clientX, e.touches[0].clientY);
        // Only prevent scroll if we've confirmed horizontal swipe direction
        if (isTracking && e.cancelable) e.preventDefault();
    }, { passive: false });

    wrap.addEventListener('touchend', onEnd);

    wrap.addEventListener('mousedown', (e) => {
        if (e.target.closest('a, button')) return;
        e.preventDefault();
        onStart(e.clientX, e.clientY);
        const mouseMoveHandler = (e2) => onMove(e2.clientX, e2.clientY);
        const mouseUpHandler = () => {
            onEnd();
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
        };
        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
    });
}

function exitSearchMode() {
    if (!isSearchMode) return;
    isSearchMode = false;
    currentMovies = [];
    currentIndex = 0;
    loadGeneration++;
    isLoading = false;

    // Show card stack UI, hide search results
    searchResults.classList.add('hidden');
    searchResults.innerHTML = '';
    cardStack.classList.remove('hidden');
    document.querySelector('.swipe-buttons').classList.remove('hidden');
    document.querySelector('.swipe-hint').classList.remove('hidden');

    resetPagination();
    loadMoreMovies().then(() => showCurrentCard());
}

// ─── Source filter tabs ──────────────────────────────────────────────
const SEARCH_PLACEHOLDERS = {
    all:        'Search for a movie or series…',
    theatrical: 'Search for a movie…',
    streaming:  'Search for a movie…',
    series:     'Search for a series…',
};

function updateSearchPlaceholder() {
    searchInput.placeholder = SEARCH_PLACEHOLDERS[activeSource] || 'Search…';
}

function setupFilterTabs() {
    filterTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const source = tab.dataset.source;
            if (source === activeSource) return;

            filterTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeSource = source;
            updateSearchPlaceholder();

            // Clear search when switching source
            if (isSearchMode) {
                searchInput.value = '';
                searchClear.classList.add('hidden');
                isSearchMode = false;
                searchResults.classList.add('hidden');
                searchResults.innerHTML = '';
                cardStack.classList.remove('hidden');
                document.querySelector('.swipe-buttons').classList.remove('hidden');
                document.querySelector('.swipe-hint').classList.remove('hidden');
            }

            // Reset and reload with new source
            currentMovies = [];
            currentIndex = 0;
            loadGeneration++;
            isLoading = false;
            resetPagination();

            cardStack.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';
            loadMoreMovies().then(() => showCurrentCard());
        });
    });
}

function setupSortSelect() {
    const sortSelect = document.getElementById('sort-select');
    if (!sortSelect) return;
    sortSelect.value = activeSortBy;
    sortSelect.addEventListener('change', () => {
        activeSortBy = sortSelect.value;
        localStorage.setItem('mt-sort', activeSortBy);

        // Re-sort unseen movies and reset to first unseen card
        const unseen = currentMovies.slice(currentIndex);
        currentMovies = [...currentMovies.slice(0, currentIndex), ...sortDiscoverMovies(unseen, activeSortBy)];
        showCurrentCard();
    });
}

function resetPagination() {
    theatricalPage = 1;
    theatricalTotalPages = Infinity;
    streamingPage = 1;
    streamingTotalPages = Infinity;
    seriesPage = 1;
    seriesTotalPages = Infinity;
    skippedQueue = [];
}

// ─── Swipe gestures ──────────────────────────────────────────────────
function setupSwipeHandlers(card) {
    let startX = 0;
    let startY = 0;
    let deltaX = 0;
    let deltaY = 0;
    let isTracking = false;
    let direction = null; // 'horizontal' | 'vertical-down' | null

    const THRESHOLD = 80;
    const DIRECTION_LOCK = 10;

    function onStart(x, y) {
        if (isSwiping) return;
        startX = x;
        startY = y;
        deltaX = 0;
        deltaY = 0;
        isTracking = true;
        direction = null;
        card.style.transition = 'none';
    }

    function onMove(x, y) {
        if (!isTracking) return;

        const dx = x - startX;
        const dy = y - startY;

        if (direction === null && (Math.abs(dx) > DIRECTION_LOCK || Math.abs(dy) > DIRECTION_LOCK)) {
            if (Math.abs(dx) > Math.abs(dy)) {
                direction = 'horizontal';
            } else if (dy > DIRECTION_LOCK) {
                direction = 'vertical-down';
            } else {
                // Vertical up — cancel tracking, allow page scroll
                isTracking = false;
                card.style.transform = '';
                return;
            }
        }

        if (!direction) return;

        const overlayInterested = card.querySelector('.overlay-interested');
        const overlayNope = card.querySelector('.overlay-nope');
        const overlaySkip = card.querySelector('.overlay-skip');

        if (direction === 'horizontal') {
            deltaX = dx;
            const rotation = deltaX * 0.08;
            card.style.transform = `translateX(${deltaX}px) rotate(${rotation}deg)`;

            const progress = Math.min(Math.abs(deltaX) / THRESHOLD, 1);
            overlaySkip.style.opacity = 0;
            if (deltaX > 0) {
                overlayInterested.style.opacity = progress;
                overlayNope.style.opacity = 0;
            } else {
                overlayNope.style.opacity = progress;
                overlayInterested.style.opacity = 0;
            }
        } else {
            // vertical-down
            deltaY = Math.max(0, dy); // only allow downward
            const scale = Math.max(0.9, 1 - deltaY * 0.0005);
            card.style.transform = `translateY(${deltaY}px) scale(${scale})`;

            const progress = Math.min(deltaY / THRESHOLD, 1);
            overlayInterested.style.opacity = 0;
            overlayNope.style.opacity = 0;
            overlaySkip.style.opacity = progress;
        }
    }

    function onEnd() {
        if (!isTracking) return;
        isTracking = false;

        if (direction === 'horizontal' && Math.abs(deltaX) > THRESHOLD) {
            const status = deltaX > 0 ? 'interested' : 'dismissed';
            commitSwipe(card, status, deltaX > 0 ? 1 : -1);
        } else if (direction === 'vertical-down' && deltaY > THRESHOLD) {
            commitSwipe(card, 'skipped', 0);
        } else {
            card.style.transition = 'transform 0.3s ease';
            card.style.transform = '';
            card.querySelector('.overlay-interested').style.opacity = 0;
            card.querySelector('.overlay-nope').style.opacity = 0;
            card.querySelector('.overlay-skip').style.opacity = 0;
        }
    }

    card.addEventListener('touchstart', (e) => {
        // Don't swipe when touching scrollable/interactive areas
        if (e.target.closest('.cast-row, .genre-badges, a, button, .overview')) return;
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
        if (direction && e.cancelable) e.preventDefault();
    }, { passive: false });

    card.addEventListener('touchend', onEnd);

    card.addEventListener('mousedown', (e) => {
        if (e.target.closest('.cast-row, .genre-badges, a, button, .overview')) return;
        e.preventDefault();
        onStart(e.clientX, e.clientY);

        const mouseMoveHandler = (e2) => onMove(e2.clientX, e2.clientY);
        const mouseUpHandler = () => {
            onEnd();
            document.removeEventListener('mousemove', mouseMoveHandler);
            document.removeEventListener('mouseup', mouseUpHandler);
        };
        document.addEventListener('mousemove', mouseMoveHandler);
        document.addEventListener('mouseup', mouseUpHandler);
    });
}

async function commitSwipe(card, status, direction) {
    if (isSwiping) return;
    isSwiping = true;

    card.style.transition = 'transform 0.35s ease, opacity 0.35s ease';

    if (status === 'skipped') {
        card.style.transform = 'translateY(500px) scale(0.8)';
        card.style.opacity = '0';
    } else {
        card.style.transform = `translateX(${direction * 500}px) rotate(${direction * 20}deg)`;
        card.style.opacity = '0';
    }

    const movie = currentMovies[currentIndex];
    await sleep(200);

    if (status === 'skipped') {
        skippedQueue.push(movie);
        showToast(`Skipped "${movie.title}"`);
    } else {
        await saveDecision(movie, status);
        showToast(status === 'interested' ? `Added "${movie.title}" to watchlist ✓` : `Dismissed "${movie.title}"`);
    }

    currentIndex++;
    showCurrentCard();

    isSwiping = false;
}

async function advanceCard(status) {
    if (isSwiping) return;
    if (currentIndex >= currentMovies.length) return;

    const card = cardStack.querySelector('.movie-card');
    if (card) {
        const direction = status === 'interested' ? 1 : -1;
        commitSwipe(card, status, direction);
    }
}

// ─── List search (watchlist / dismissed) ─────────────────────────────
let watchlistFilter = '';
let dismissedFilter = '';
let seenFilter = '';
let seenSortBy = 'recent';

function setupListSearch() {
    const watchlistSearch = document.getElementById('watchlist-search');
    const watchlistClear = document.getElementById('watchlist-search-clear');
    const dismissedSearch = document.getElementById('dismissed-search');
    const dismissedClear = document.getElementById('dismissed-search-clear');

    watchlistSearch.addEventListener('input', () => {
        watchlistFilter = watchlistSearch.value.trim().toLowerCase();
        watchlistClear.classList.toggle('hidden', watchlistFilter.length === 0);
        renderWatchlist();
    });
    watchlistClear.addEventListener('click', () => {
        watchlistSearch.value = '';
        watchlistFilter = '';
        watchlistClear.classList.add('hidden');
        renderWatchlist();
    });

    dismissedSearch.addEventListener('input', () => {
        dismissedFilter = dismissedSearch.value.trim().toLowerCase();
        dismissedClear.classList.toggle('hidden', dismissedFilter.length === 0);
        renderDismissed();
    });
    dismissedClear.addEventListener('click', () => {
        dismissedSearch.value = '';
        dismissedFilter = '';
        dismissedClear.classList.add('hidden');
        renderDismissed();
    });

    const seenSearch = document.getElementById('seen-search');
    const seenClear = document.getElementById('seen-search-clear');
    seenSearch.addEventListener('input', () => {
        seenFilter = seenSearch.value.trim().toLowerCase();
        seenClear.classList.toggle('hidden', seenFilter.length === 0);
        renderSeen();
    });
    seenClear.addEventListener('click', () => {
        seenSearch.value = '';
        seenFilter = '';
        seenClear.classList.add('hidden');
        renderSeen();
    });

    const seenSortEl = document.getElementById('seen-sort');
    if (seenSortEl) {
        seenSortEl.addEventListener('change', () => {
            seenSortBy = seenSortEl.value;
            renderSeen();
        });
    }
}

function matchesFilter(movie, filter) {
    if (!filter) return true;
    const title = (movie.title || '').toLowerCase();
    const genres = (movie.genres || []).join(' ').toLowerCase();
    return title.includes(filter) || genres.includes(filter);
}

// ─── Media type filter helper ────────────────────────────────────────
function matchesMediaType(movie, filter) {
    if (!filter || filter === 'all') return true;
    return (movie.mediaType || 'movie') === filter;
}

// ─── Watchlist view ──────────────────────────────────────────────────
function renderWatchlist() {
    const interested = [];
    userMovies.forEach((m) => {
        if (m.status === 'interested' && matchesFilter(m, watchlistFilter) && matchesMediaType(m, watchlistMediaFilter)) interested.push(m);
    });

    interested.sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || ''));

    if (interested.length === 0) {
        const msg = watchlistFilter
            ? `No matches for "${watchlistFilter}".`
            : 'Your watchlist is empty.';
        const hint = watchlistFilter
            ? 'Try a different search term.'
            : 'Swipe right on titles you want to see!';
        watchlistContainer.innerHTML = `<div class="empty-state"><p>${msg}</p><p class="hint">${hint}</p></div>`;
        return;
    }

    const now = new Date();
    const groups = groupByTimeframe(interested, now);
    let html = '';

    for (const [label, movies] of groups) {
        if (movies.length === 0) continue;
        html += `<h3 class="group-header">${label} <span class="group-count">(${movies.length})</span></h3>`;
        html += '<div class="watchlist-grid">';
        movies.forEach(m => {
            const posterUrl = getImageUrl(m.posterPath, 'w185');
            const releaseFormatted = formatDate(m.releaseDate);
            const isReleasingSoon = isWithinDays(m.releaseDate, 7);
            const isPast = m.releaseDate && new Date(m.releaseDate) <= now;
            const rating = m.voteAverage ? m.voteAverage.toFixed(1) : null;

            html += `
                <div class="watchlist-grid-item" data-tmdb-id="${m.tmdbId}" data-media-type="${m.mediaType || 'movie'}">
                    <div class="wl-poster-wrap">
                        ${posterUrl
                            ? `<img src="${posterUrl}" alt="${m.title}" class="wl-poster">`
                            : '<div class="wl-poster-placeholder">?</div>'}
                        ${isPast
                            ? '<div class="wl-available-badge"><span>Available</span></div>'
                            : isReleasingSoon
                                ? '<div class="wl-soon-badge">Soon</div>'
                                : ''}
                        ${rating ? `<div class="wl-rating-badge">★${rating}</div>` : ''}
                        <div class="wl-date-strip">${isPast ? 'Out now' : releaseFormatted}</div>
                        <div class="wl-actions">
                            <button class="btn-wl-seen" title="Mark as seen" data-tmdb-id="${m.tmdbId}" data-media-type="${m.mediaType || 'movie'}">✓</button>
                            <button class="btn-wl-remove" title="Dismiss" data-tmdb-id="${m.tmdbId}" data-media-type="${m.mediaType || 'movie'}">✕</button>
                        </div>
                    </div>
                    <p class="wl-title">${m.title}</p>
                </div>
            `;
        });
        html += '</div>';
    }

    watchlistContainer.innerHTML = html;

    watchlistContainer.querySelectorAll('.btn-wl-remove').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.tmdbId);
            const mt = btn.dataset.mediaType || 'movie';
            const key = mediaKey(id, mt);
            const movie = userMovies.get(key);
            if (movie) {
                const wlDocId = mt === 'tv' ? `tv_${id}` : String(id);
                const movieRef = doc(db, 'users', currentUser.uid, 'movies', wlDocId);
                await setDoc(movieRef, { ...movie, status: 'dismissed', decidedAt: new Date().toISOString() });
                showToast(`Moved "${movie.title}" to dismissed`);
            }
        });
    });

    watchlistContainer.querySelectorAll('.btn-wl-seen').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openRatingModal(mediaKey(Number(btn.dataset.tmdbId), btn.dataset.mediaType || 'movie'));
        });
    });

    watchlistContainer.querySelectorAll('.watchlist-grid-item').forEach(item => {
        item.addEventListener('click', () => {
            openDetail(Number(item.dataset.tmdbId), item.dataset.mediaType || 'movie');
        });
    });
}

// ─── Dismissed view ──────────────────────────────────────────────────
function renderDismissed() {
    const dismissed = [];
    userMovies.forEach((m) => {
        if (m.status === 'dismissed' && matchesFilter(m, dismissedFilter) && matchesMediaType(m, dismissedMediaFilter)) dismissed.push(m);
    });

    dismissed.sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));

    if (dismissed.length === 0) {
        const msg = dismissedFilter
            ? `No matches for "${dismissedFilter}".`
            : 'No dismissed movies.';
        const hint = dismissedFilter
            ? 'Try a different search term.'
            : 'Movies you pass on will appear here.';
        dismissedContainer.innerHTML = `<div class="empty-state"><p>${msg}</p><p class="hint">${hint}</p></div>`;
        return;
    }

    let html = '<div class="dismissed-grid">';
    dismissed.forEach(m => {
        const posterUrl = getImageUrl(m.posterPath, 'w185');
        html += `
            <div class="dismissed-item" data-tmdb-id="${m.tmdbId}" data-media-type="${m.mediaType || 'movie'}">
                ${posterUrl
                    ? `<img src="${posterUrl}" alt="${m.title}">`
                    : '<div class="no-poster-sm">?</div>'}
                <p class="dismissed-title">${m.title}</p>
                <button class="btn-restore" title="Restore to watchlist" data-tmdb-id="${m.tmdbId}" data-media-type="${m.mediaType || 'movie'}">↩</button>
            </div>
        `;
    });
    html += '</div>';
    dismissedContainer.innerHTML = html;

    dismissedContainer.querySelectorAll('.btn-restore').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.tmdbId);
            const mt = btn.dataset.mediaType || 'movie';
            const key = mediaKey(id, mt);
            const movie = userMovies.get(key);
            if (movie) {
                const restoreDocId = mt === 'tv' ? `tv_${id}` : String(id);
                const movieRef = doc(db, 'users', currentUser.uid, 'movies', restoreDocId);
                await setDoc(movieRef, { ...movie, status: 'interested', decidedAt: new Date().toISOString() });
                showToast(`Restored "${movie.title}" to watchlist ✓`);
            }
        });
    });

    dismissedContainer.querySelectorAll('.dismissed-item').forEach(item => {
        item.addEventListener('click', () => {
            openDetail(Number(item.dataset.tmdbId), item.dataset.mediaType || 'movie');
        });
        item.style.cursor = 'pointer';
    });
}

// ─── Seen view ──────────────────────────────────────────────────────
function renderSeen() {
    const allSeen = [];
    userMovies.forEach((m) => { if (m.status === 'seen') allSeen.push(m); });

    // Update stats bar (counts all seen, ignores filter)
    const statsEl = document.getElementById('seen-stats');
    if (statsEl) {
        if (allSeen.length > 0) {
            const rated = allSeen.filter(m => m.rating);
            const avg = rated.length
                ? (rated.reduce((s, m) => s + m.rating, 0) / rated.length).toFixed(1)
                : null;
            statsEl.textContent = `${allSeen.length} movie${allSeen.length !== 1 ? 's' : ''}${avg ? ` · avg ★ ${avg}` : ''}`;
            statsEl.classList.remove('hidden');
        } else {
            statsEl.classList.add('hidden');
        }
    }

    const seen = allSeen.filter(m => matchesFilter(m, seenFilter) && matchesMediaType(m, seenMediaFilter));

    // Sort
    seen.sort((a, b) => {
        if (seenSortBy === 'rating') return (b.rating || 0) - (a.rating || 0);
        if (seenSortBy === 'title') return (a.title || '').localeCompare(b.title || '');
        if (seenSortBy === 'year') return (b.releaseDate || '').localeCompare(a.releaseDate || '');
        return (b.seenAt || '').localeCompare(a.seenAt || ''); // recent
    });

    if (seen.length === 0) {
        const msg = seenFilter ? `No matches for "${seenFilter}".` : 'No seen movies yet.';
        const hint = seenFilter ? 'Try a different search term.' : 'Mark movies as seen from your watchlist!';
        seenContainer.innerHTML = `<div class="empty-state"><p>${msg}</p><p class="hint">${hint}</p></div>`;
        return;
    }

    let html = '<div class="seen-grid">';
    seen.forEach(m => {
        const posterUrl = getImageUrl(m.posterPath, 'w185');
        const userRating = m.rating != null ? m.rating : null;
        const seenDate = m.seenAt ? formatDate(m.seenAt.split('T')[0]) : '';

        html += `
            <div class="seen-grid-item" data-tmdb-id="${m.tmdbId}" data-media-type="${m.mediaType || 'movie'}">
                <div class="seen-poster-wrap">
                    ${posterUrl
                        ? `<img src="${posterUrl}" alt="${m.title}" class="seen-poster">`
                        : '<div class="seen-poster seen-no-poster">?</div>'}
                    ${userRating != null
                        ? `<span class="seen-rating-badge">★${userRating}</span>`
                        : '<span class="seen-rating-badge seen-rating-none">—</span>'}
                    <button class="seen-edit-btn" title="Edit rating" data-tmdb-id="${m.tmdbId}" data-media-type="${m.mediaType || 'movie'}">✏</button>
                </div>
                <p class="seen-grid-title">${m.title}</p>
                ${seenDate ? `<p class="seen-grid-date">${seenDate}</p>` : ''}
            </div>
        `;
    });
    html += '</div>';
    seenContainer.innerHTML = html;

    seenContainer.querySelectorAll('.seen-grid-item').forEach(item => {
        item.addEventListener('click', (e) => {
            if (e.target.closest('.seen-edit-btn')) return; // handled separately
            openDetail(Number(item.dataset.tmdbId), item.dataset.mediaType || 'movie');
        });
        item.style.cursor = 'pointer';
    });

    seenContainer.querySelectorAll('.seen-edit-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            openRatingModal(mediaKey(Number(btn.dataset.tmdbId), btn.dataset.mediaType || 'movie'), true);
        });
    });
}

// ─── Rating modal ───────────────────────────────────────────────────
let ratingModalMovieId = null;
let ratingModalValue = null;

function openRatingModal(tmdbId, isEdit = false) {
    ratingModalMovieId = tmdbId;
    ratingModalValue = null;
    const movie = userMovies.get(tmdbId);
    if (!movie) return;

    // Update modal heading based on context
    document.querySelector('#rating-modal .modal-title').textContent =
        isEdit ? 'Update Rating' : 'Mark as Seen';
    document.getElementById('rating-modal-title').textContent = movie.title;

    const existingRating = movie.rating || null;

    const buttonsContainer = document.getElementById('rating-buttons');
    buttonsContainer.innerHTML = '';
    for (let i = 1; i <= 10; i++) {
        const btn = document.createElement('button');
        btn.className = 'rating-btn';
        btn.textContent = i;
        // Pre-select existing rating when editing
        if (existingRating === i) {
            btn.classList.add('selected');
            ratingModalValue = i;
        }
        btn.addEventListener('click', () => {
            ratingModalValue = i;
            buttonsContainer.querySelectorAll('.rating-btn').forEach(b => b.classList.remove('selected'));
            btn.classList.add('selected');
        });
        buttonsContainer.appendChild(btn);
    }

    document.getElementById('rating-modal').classList.remove('hidden');
}

function closeRatingModal() {
    document.getElementById('rating-modal').classList.add('hidden');
    ratingModalMovieId = null;
    ratingModalValue = null;
}

document.getElementById('rating-cancel').addEventListener('click', closeRatingModal);
document.getElementById('rating-save').addEventListener('click', async () => {
    if (ratingModalMovieId === null || ratingModalValue === null) {
        showToast('Please select a rating');
        return;
    }
    const movie = userMovies.get(ratingModalMovieId);
    if (movie) {
        const movieRef = doc(db, 'users', currentUser.uid, 'movies', String(ratingModalMovieId));
        // Preserve existing seenAt if already set (editing a rating, not fresh mark)
        const seenAt = movie.seenAt || new Date().toISOString();
        await setDoc(movieRef, {
            ...movie,
            status: 'seen',
            rating: ratingModalValue,
            seenAt,
        });
        showToast(`Rated "${movie.title}" ${ratingModalValue}/10 ★`);
    }
    closeRatingModal();
});

// Close modal on overlay click
document.getElementById('rating-modal').addEventListener('click', (e) => {
    if (e.target.id === 'rating-modal') closeRatingModal();
});

// ─── Release notifications ───────────────────────────────────────────

// Persist watchlist to localStorage so the service worker can check
// release dates in the background (periodic sync / sync events).
function persistWatchlistForSW() {
    const interested = [];
    userMovies.forEach(m => {
        if (m.status === 'interested') {
            interested.push({
                tmdbId: m.tmdbId,
                title: m.title,
                releaseDate: m.releaseDate,
                posterPath: m.posterPath
            });
        }
    });
    try { localStorage.setItem('mt-watchlist', JSON.stringify(interested)); } catch {}
}

function checkReleaseNotifications() {
    // Persist for background checks regardless of notification permission
    persistWatchlistForSW();

    // Only show in-app notifications if permission is granted
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const todayStr = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    // Use localStorage for dedup so notifications survive across sessions
    // but still allow "tomorrow" → "today" progression
    let notified = {};
    try { notified = JSON.parse(localStorage.getItem('mt-notified') || '{}'); } catch {}

    userMovies.forEach(m => {
        if (m.status !== 'interested') return;
        if (!m.releaseDate) return;

        const dayKey = `${m.tmdbId}-${todayStr}`;

        if (m.releaseDate === todayStr && !notified[dayKey]) {
            new Notification('Movie Tracker', {
                body: `"${m.title}" releases today!`,
                icon: getImageUrl(m.posterPath, 'w92') || undefined,
                tag: `release-${m.tmdbId}-today`
            });
            notified[dayKey] = 1;
        } else if (m.releaseDate === tomorrow && !notified[`${m.tmdbId}-tomorrow-${todayStr}`]) {
            new Notification('Movie Tracker', {
                body: `"${m.title}" releases tomorrow!`,
                icon: getImageUrl(m.posterPath, 'w92') || undefined,
                tag: `release-${m.tmdbId}-tomorrow`
            });
            notified[`${m.tmdbId}-tomorrow-${todayStr}`] = 1;
        }
    });

    try { localStorage.setItem('mt-notified', JSON.stringify(notified)); } catch {}
}

async function requestNotificationPermission() {
    if (!('Notification' in window)) return;
    if (Notification.permission === 'default') {
        const result = await Notification.requestPermission();
        if (result === 'granted') {
            showToast('Notifications enabled — you\'ll be notified on release days!');
        }
    }
}

// ─── View switching ──────────────────────────────────────────────────
function switchView(viewName) {
    views.forEach(v => v.classList.remove('active'));
    bottomTabs.forEach(b => b.classList.remove('active'));
    document.getElementById(`view-${viewName}`).classList.add('active');
    document.querySelector(`.bottom-tabs button[data-view="${viewName}"]`).classList.add('active');
    window.scrollTo(0, 0);
}

bottomTabs.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
});

// ─── Tab badges ──────────────────────────────────────────────────────
function updateTabBadges() {
    let watchCount = 0;
    let seenCount = 0;
    let dismissCount = 0;
    userMovies.forEach(m => {
        if (m.status === 'interested') watchCount++;
        else if (m.status === 'seen') seenCount++;
        else if (m.status === 'dismissed') dismissCount++;
    });

    const watchBadge = document.getElementById('badge-watchlist');
    const seenBadge = document.getElementById('badge-seen');
    const dismissBadge = document.getElementById('badge-dismissed');

    if (watchCount > 0) { watchBadge.textContent = watchCount; watchBadge.classList.remove('hidden'); }
    else { watchBadge.classList.add('hidden'); }

    if (seenCount > 0) { seenBadge.textContent = seenCount; seenBadge.classList.remove('hidden'); }
    else { seenBadge.classList.add('hidden'); }

    if (dismissCount > 0) { dismissBadge.textContent = dismissCount; dismissBadge.classList.remove('hidden'); }
    else { dismissBadge.classList.add('hidden'); }
}

// ─── Keyboard navigation ────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    const discoverView = document.getElementById('view-discover');
    if (!discoverView.classList.contains('active')) return;
    // Don't capture keys while typing in search
    if (document.activeElement === searchInput) return;

    if (e.key === 'ArrowRight') {
        e.preventDefault();
        advanceCard('interested');
    } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        advanceCard('dismissed');
    }
});

// ─── Toast ───────────────────────────────────────────────────────────
let toastTimeout = null;
function showToast(message) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.classList.add('show');
    if (toastTimeout) clearTimeout(toastTimeout);
    toastTimeout = setTimeout(() => toast.classList.remove('show'), 2500);
}

// ─── Helpers ─────────────────────────────────────────────────────────
function formatDate(dateStr) {
    if (!dateStr) return 'TBA';
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

function truncate(str, max) {
    if (!str) return '';
    return str.length > max ? str.slice(0, max) + '…' : str;
}

function escapeAttr(str) {
    return (str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function isWithinDays(dateStr, days) {
    if (!dateStr) return false;
    const d = new Date(dateStr);
    const now = new Date();
    const diff = d - now;
    return diff > 0 && diff < days * 24 * 60 * 60 * 1000;
}

function groupByTimeframe(movies, now) {
    const thisWeek = [];
    const thisMonth = [];
    const later = [];
    const available = [];

    const weekFromNow = new Date(now);
    weekFromNow.setDate(weekFromNow.getDate() + 7);
    const monthFromNow = new Date(now);
    monthFromNow.setMonth(monthFromNow.getMonth() + 1);

    movies.forEach(m => {
        if (!m.releaseDate) { later.push(m); return; }
        const d = new Date(m.releaseDate);
        if (d <= now) available.push(m);
        else if (d <= weekFromNow) thisWeek.push(m);
        else if (d <= monthFromNow) thisMonth.push(m);
        else later.push(m);
    });

    return [
        ['Now Available', available],
        ['This Week', thisWeek],
        ['This Month', thisMonth],
        ['Later', later]
    ];
}

// ─── Button handlers ─────────────────────────────────────────────────
btnInterested.addEventListener('click', () => advanceCard('interested'));
btnDismiss.addEventListener('click', () => advanceCard('dismissed'));

// ─── Google sign-in button ───────────────────────────────────────────
document.getElementById('btn-google-signin').addEventListener('click', signInWithGoogle);
document.getElementById('btn-signout').addEventListener('click', handleSignOut);

// Notifications disabled — button removed from UI

// ─── Metric info popups ──────────────────────────────────────────────
const METRIC_INFO = {
    tmdb: {
        title: 'TMDb User Rating',
        desc: 'Average score (0–10) from registered TMDb users. Reflects broad audience consensus across tens of millions of ratings.',
        ranges: [
            { val: '< 5',  label: 'Poor reception' },
            { val: '5–6',  label: 'Mixed reviews' },
            { val: '6–7',  label: 'Generally favorable' },
            { val: '7–8',  label: 'Well received' },
            { val: '8–9',  label: 'Highly acclaimed' },
            { val: '9–10', label: 'Masterpiece' },
        ],
    },
    popularity: {
        title: 'TMDb Popularity',
        desc: 'A daily score based on page views, watchlist adds, and vote activity on TMDb. Resets frequently — 100+ means actively trending.',
        ranges: [
            { val: '< 10',    label: 'Niche' },
            { val: '10–50',   label: 'Moderate interest' },
            { val: '50–100',  label: 'Trending' },
            { val: '100–500', label: 'Very popular' },
            { val: '500–1k',  label: 'Blockbuster' },
            { val: '1k+',     label: 'Top trending' },
        ],
    },
    imdb: {
        title: 'IMDb Rating',
        desc: 'Average score (0–10) from IMDb\'s registered users — one of the world\'s largest film databases with 200M+ users.',
        ranges: [
            { val: '< 4',  label: 'Very poor' },
            { val: '4–5',  label: 'Poor' },
            { val: '5–6',  label: 'Mixed' },
            { val: '6–7',  label: 'Above average' },
            { val: '7–8',  label: 'Good' },
            { val: '8–10', label: 'Excellent' },
        ],
    },
    rt: {
        title: 'Rotten Tomatoes',
        desc: 'Tomatometer: percentage of positive reviews from approved critics. 60%+ = Fresh, below 60% = Rotten.',
        ranges: [
            { val: '< 30%',   label: 'Rotten' },
            { val: '30–59%',  label: 'Generally unfavorable' },
            { val: '60–74%',  label: '🍅 Fresh' },
            { val: '75–89%',  label: 'Certified Fresh' },
            { val: '90–100%', label: 'Must Watch' },
        ],
    },
    mc: {
        title: 'Metacritic',
        desc: 'Metascore: a weighted average of professional critic reviews scaled 0–100. Weights reflect the prestige of each publication.',
        ranges: [
            { val: '< 20',  label: 'Overwhelming dislike' },
            { val: '20–39', label: 'Generally unfavorable' },
            { val: '40–60', label: 'Mixed or average' },
            { val: '61–79', label: 'Generally favorable' },
            { val: '80+',   label: 'Universal acclaim' },
        ],
    },
};

function getMetricKey(el) {
    const badge = el.closest('.score-badge');
    if (badge) {
        if (badge.classList.contains('popularity')) return 'popularity';
        if (badge.classList.contains('rating'))     return 'tmdb';
        if (badge.classList.contains('imdb'))       return 'imdb';
        if (badge.classList.contains('rt'))         return 'rt';
        if (badge.classList.contains('mc'))         return 'mc';
    }
    if (el.closest('.detail-score, .detail-score-label')) return 'tmdb';
    if (el.closest('.detail-ext-score.rt-score'))         return 'rt';
    if (el.closest('.detail-ext-score.metacritic-score')) return 'mc';
    return null;
}

function setupInfoPopups() {
    const popup    = document.getElementById('info-popup');
    const titleEl  = document.getElementById('info-popup-title');
    const descEl   = document.getElementById('info-popup-desc');
    const rangesEl = document.getElementById('info-popup-ranges');
    const closeBtn = document.getElementById('info-popup-close');

    function showPopup(key) {
        const info = METRIC_INFO[key];
        if (!info) return;
        titleEl.textContent = info.title;
        descEl.textContent  = info.desc;
        rangesEl.innerHTML  = info.ranges.map(r =>
            `<div class="range-item"><span class="range-val">${r.val}</span><span class="range-label">${r.label}</span></div>`
        ).join('');
        popup.classList.remove('hidden');
    }

    document.addEventListener('click', (e) => {
        const key = getMetricKey(e.target);
        if (key) {
            e.stopPropagation();
            showPopup(key);
            return;
        }
        if (!popup.classList.contains('hidden') && !popup.contains(e.target)) {
            popup.classList.add('hidden');
        }
    });

    closeBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        popup.classList.add('hidden');
    });
}

// ─── Media type tabs ─────────────────────────────────────────────────
function setupMediaTypeTabs() {
    function wire(containerId, getFilter, setFilter, rerender) {
        const container = document.getElementById(containerId);
        if (!container) return;
        container.querySelectorAll('.media-tab').forEach(btn => {
            btn.addEventListener('click', () => {
                if (btn.dataset.media === getFilter()) return;
                container.querySelectorAll('.media-tab').forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                setFilter(btn.dataset.media);
                rerender();
            });
        });
    }
    wire('watchlist-media-tabs',
        () => watchlistMediaFilter,
        v => { watchlistMediaFilter = v; },
        renderWatchlist
    );
    wire('seen-media-tabs',
        () => seenMediaFilter,
        v => { seenMediaFilter = v; },
        renderSeen
    );
    wire('dismissed-media-tabs',
        () => dismissedMediaFilter,
        v => { dismissedMediaFilter = v; },
        renderDismissed
    );
}

// ─── Init ────────────────────────────────────────────────────────────
async function init() {
    switchView('discover');
    setupSearch();
    setupFilterTabs();
    updateSearchPlaceholder();
    setupSortSelect();
    setupListSearch();
    setupMediaTypeTabs();
    setupInfoPopups();

    // Register service worker for PWA support + background notifications
    if ('serviceWorker' in navigator) {
        try {
            const swPath = new URL('sw.js', document.baseURI).pathname;
            const registration = await navigator.serviceWorker.register(swPath);

            // Register periodic background sync for release notifications
            // (Chrome/Edge on installed PWAs — ~once per day minimum)
            if ('periodicSync' in registration) {
                try {
                    await registration.periodicSync.register('check-releases', {
                        minInterval: 12 * 60 * 60 * 1000  // 12 hours
                    });
                } catch { /* periodic sync requires installed PWA */ }
            }
        } catch (error) {
            console.error('❌ Service worker registration failed:', error);
        }
    }

    cardStack.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading movies…</p></div>';

    await ensureAuth();
    listenToDecisions();
    await fetchGenres();
    await loadMoreMovies();

    showCurrentCard();

    // Auto-prompt Google sign-in for anonymous users (requires googleClientId in config)
    tryGoogleOneTap();
}

init();
