// ─── Firebase imports ────────────────────────────────────────────────
import { firebaseConfig } from './firebase-config.js';
import { initializeApp } from "https://www.gstatic.com/firebasejs/12.10.0/firebase-app.js";
import { getFirestore, collection, doc, setDoc, deleteDoc, onSnapshot }
    from "https://www.gstatic.com/firebasejs/12.10.0/firebase-firestore.js";
import { getAuth, signInAnonymously, onAuthStateChanged }
    from "https://www.gstatic.com/firebasejs/12.10.0/firebase-auth.js";

// ─── Firebase init ───────────────────────────────────────────────────
const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

// ─── TMDB config ─────────────────────────────────────────────────────
const TMDB_API_KEY = "c79a593d431f1406489c49f923bc042e";
const TMDB_BASE = "https://api.themoviedb.org/3";

// Streaming provider IDs for TMDB watch/providers
const STREAMING_PROVIDERS = '8|337|9|350|531|384|15'; // Netflix, Disney+, Prime, Apple TV+, Paramount+, Max, Hulu

// ─── App state ───────────────────────────────────────────────────────
let currentUser = null;
let userMovies = new Map();       // tmdbId → { status, title, ... }
let genreMap = {};                // genreId → "Action", "Comedy", etc.
let currentMovies = [];           // undecided movies for the discover feed
let currentIndex = 0;
let currentPage = 1;
let totalPages = Infinity;        // track TMDB total pages to stop fetching
let isLoading = false;
let isSwiping = false;
let trailerCache = new Map();     // tmdbId → YouTube URL (or null)
let castCache = new Map();        // tmdbId → [ { name, character, profilePath }, ... ]
let activeSource = 'all';         // 'all', 'theatrical', 'streaming'
let isSearchMode = false;
let searchDebounceTimer = null;

// Separate page counters per source
let theatricalPage = 1;
let theatricalTotalPages = Infinity;
let streamingPage = 1;
let streamingTotalPages = Infinity;

// ─── DOM refs ────────────────────────────────────────────────────────
const cardStack = document.getElementById('card-stack');
const watchlistContainer = document.getElementById('watchlist-container');
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
function ensureAuth() {
    return new Promise((resolve) => {
        onAuthStateChanged(auth, (user) => {
            if (user) {
                currentUser = user;
                resolve(user);
            } else {
                signInAnonymously(auth);
            }
        });
    });
}

// ─── TMDB API ────────────────────────────────────────────────────────
async function fetchGenres() {
    const url = `${TMDB_BASE}/genre/movie/list?api_key=${TMDB_API_KEY}&language=en-US`;
    const res = await fetch(url);
    const data = await res.json();
    data.genres.forEach(g => { genreMap[g.id] = g.name; });
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

async function searchMovies(query, page = 1) {
    const url = `${TMDB_BASE}/search/movie?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=${page}`;
    const res = await fetch(url);
    const data = await res.json();
    return (data.results || []).map(m => ({ ...m, _source: 'search' }));
}

async function fetchTrailer(tmdbId) {
    if (trailerCache.has(tmdbId)) return trailerCache.get(tmdbId);
    try {
        const url = `${TMDB_BASE}/movie/${tmdbId}/videos?api_key=${TMDB_API_KEY}`;
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
        trailerCache.set(tmdbId, ytUrl);
        return ytUrl;
    } catch {
        trailerCache.set(tmdbId, null);
        return null;
    }
}

async function fetchCredits(tmdbId) {
    if (castCache.has(tmdbId)) return castCache.get(tmdbId);
    try {
        const url = `${TMDB_BASE}/movie/${tmdbId}/credits?api_key=${TMDB_API_KEY}`;
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
        castCache.set(tmdbId, result);
        return result;
    } catch {
        const fallback = { cast: [], directors: [] };
        castCache.set(tmdbId, fallback);
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
    const movieRef = doc(db, 'users', currentUser.uid, 'movies', String(movie.id));
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
        decidedAt: new Date().toISOString()
    });
}

function listenToDecisions() {
    if (!currentUser) return;
    const moviesRef = collection(db, 'users', currentUser.uid, 'movies');
    onSnapshot(moviesRef, (snapshot) => {
        userMovies.clear();
        snapshot.forEach((d) => {
            userMovies.set(d.data().tmdbId, d.data());
        });
        renderWatchlist();
        renderDismissed();
        updateTabBadges();
        checkReleaseNotifications();
    });
}

// ─── Discover feed ───────────────────────────────────────────────────
function getUndecidedMovies(movies) {
    return movies.filter(m => !userMovies.has(m.id));
}

async function loadMoreMovies() {
    if (isLoading) return;
    isLoading = true;
    try {
        let newMovies = [];

        if (activeSource === 'theatrical' || activeSource === 'all') {
            if (theatricalPage <= theatricalTotalPages) {
                const theatrical = await fetchUpcoming(theatricalPage);
                newMovies.push(...theatrical);
                theatricalPage++;
            }
        }

        if (activeSource === 'streaming' || activeSource === 'all') {
            if (streamingPage <= streamingTotalPages) {
                const streaming = await fetchStreaming(streamingPage);
                newMovies.push(...streaming);
                streamingPage++;
            }
        }

        // Deduplicate by movie id (same movie could appear in both sources)
        const existingIds = new Set(currentMovies.map(m => m.id));
        newMovies = newMovies.filter(m => !existingIds.has(m.id));

        const undecided = getUndecidedMovies(newMovies);
        currentMovies.push(...undecided);
    } catch (err) {
        console.error('Failed to fetch movies:', err);
    }
    isLoading = false;
}

function updateDiscoverCounter() {
    const remaining = currentMovies.length - currentIndex;
    if (remaining > 0 && !isSearchMode) {
        discoverCounter.textContent = `${remaining} movie${remaining !== 1 ? 's' : ''} to discover`;
        discoverCounter.classList.remove('hidden');
    } else if (isSearchMode) {
        discoverCounter.textContent = `${remaining} result${remaining !== 1 ? 's' : ''}`;
        discoverCounter.classList.remove('hidden');
    } else {
        discoverCounter.classList.add('hidden');
    }
}

function showCurrentCard() {
    cardStack.innerHTML = '';
    updateDiscoverCounter();

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
        : movie._source === 'search'
            ? ''
            : '<span class="source-badge theatrical">Theatrical</span>';

    const card = document.createElement('div');
    card.className = 'movie-card';
    card.innerHTML = `
        <div class="swipe-overlay overlay-interested">INTERESTED</div>
        <div class="swipe-overlay overlay-nope">NOPE</div>
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
                <span class="score-badge rating" title="TMDB Rating">★ ${rating}</span>
                <span class="score-badge popularity" title="Popularity">🔥 ${popularity}</span>
            </div>
            ${genres.length > 0
                ? `<div class="genre-badges">${genres.map(g => `<span class="genre-badge">${g}</span>`).join('')}</div>`
                : ''}
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
    fetchCredits(movie.id).then(({ cast, directors }) => {
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

    // Fetch trailer async
    fetchTrailer(movie.id).then(ytUrl => {
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

    setupSwipeHandlers(card);
}

// ─── Search ──────────────────────────────────────────────────────────
function setupSearch() {
    searchInput.addEventListener('input', () => {
        const query = searchInput.value.trim();
        searchClear.classList.toggle('hidden', query.length === 0);

        if (searchDebounceTimer) clearTimeout(searchDebounceTimer);

        if (query.length === 0) {
            exitSearchMode();
            return;
        }

        searchDebounceTimer = setTimeout(() => {
            enterSearchMode(query);
        }, 400); // Wait 400ms after typing stops
    });

    searchClear.addEventListener('click', () => {
        searchInput.value = '';
        searchClear.classList.add('hidden');
        exitSearchMode();
    });
}

async function enterSearchMode(query) {
    isSearchMode = true;
    currentMovies = [];
    currentIndex = 0;

    cardStack.innerHTML = '<div class="loading"><div class="spinner"></div><p>Searching…</p></div>';

    try {
        const results = await searchMovies(query);
        const undecided = getUndecidedMovies(results);
        currentMovies = undecided;
    } catch (err) {
        console.error('Search failed:', err);
    }

    showCurrentCard();
}

function exitSearchMode() {
    if (!isSearchMode) return;
    isSearchMode = false;
    currentMovies = [];
    currentIndex = 0;
    // Reset page counters and reload
    resetPagination();
    loadMoreMovies().then(() => showCurrentCard());
}

// ─── Source filter tabs ──────────────────────────────────────────────
function setupFilterTabs() {
    filterTabs.forEach(tab => {
        tab.addEventListener('click', () => {
            const source = tab.dataset.source;
            if (source === activeSource) return;

            filterTabs.forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            activeSource = source;

            // Clear search when switching source
            if (isSearchMode) {
                searchInput.value = '';
                searchClear.classList.add('hidden');
                isSearchMode = false;
            }

            // Reset and reload with new source
            currentMovies = [];
            currentIndex = 0;
            resetPagination();

            cardStack.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading…</p></div>';
            loadMoreMovies().then(() => showCurrentCard());
        });
    });
}

function resetPagination() {
    theatricalPage = 1;
    theatricalTotalPages = Infinity;
    streamingPage = 1;
    streamingTotalPages = Infinity;
}

// ─── Swipe gestures ──────────────────────────────────────────────────
function setupSwipeHandlers(card) {
    let startX = 0;
    let startY = 0;
    let deltaX = 0;
    let isTracking = false;
    let isHorizontal = null;

    const THRESHOLD = 80;
    const DIRECTION_LOCK = 10;

    function onStart(x, y) {
        if (isSwiping) return;
        startX = x;
        startY = y;
        deltaX = 0;
        isTracking = true;
        isHorizontal = null;
        card.style.transition = 'none';
    }

    function onMove(x, y) {
        if (!isTracking) return;

        const dx = x - startX;
        const dy = y - startY;

        if (isHorizontal === null && (Math.abs(dx) > DIRECTION_LOCK || Math.abs(dy) > DIRECTION_LOCK)) {
            isHorizontal = Math.abs(dx) > Math.abs(dy);
            if (!isHorizontal) {
                isTracking = false;
                card.style.transform = '';
                return;
            }
        }

        if (!isHorizontal) return;

        deltaX = dx;
        const rotation = deltaX * 0.08;
        card.style.transform = `translateX(${deltaX}px) rotate(${rotation}deg)`;

        const overlayInterested = card.querySelector('.overlay-interested');
        const overlayNope = card.querySelector('.overlay-nope');
        const progress = Math.min(Math.abs(deltaX) / THRESHOLD, 1);

        if (deltaX > 0) {
            overlayInterested.style.opacity = progress;
            overlayNope.style.opacity = 0;
        } else {
            overlayNope.style.opacity = progress;
            overlayInterested.style.opacity = 0;
        }
    }

    function onEnd() {
        if (!isTracking) return;
        isTracking = false;

        if (Math.abs(deltaX) > THRESHOLD) {
            const status = deltaX > 0 ? 'interested' : 'dismissed';
            commitSwipe(card, status, deltaX > 0 ? 1 : -1);
        } else {
            card.style.transition = 'transform 0.3s ease';
            card.style.transform = '';
            card.querySelector('.overlay-interested').style.opacity = 0;
            card.querySelector('.overlay-nope').style.opacity = 0;
        }
    }

    card.addEventListener('touchstart', (e) => {
        const t = e.touches[0];
        onStart(t.clientX, t.clientY);
    }, { passive: true });

    card.addEventListener('touchmove', (e) => {
        const t = e.touches[0];
        onMove(t.clientX, t.clientY);
        if (isHorizontal) e.preventDefault();
    }, { passive: false });

    card.addEventListener('touchend', onEnd);

    card.addEventListener('mousedown', (e) => {
        if (e.target.closest('a, button, .overview')) return;
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
    card.style.transform = `translateX(${direction * 500}px) rotate(${direction * 20}deg)`;
    card.style.opacity = '0';

    const movie = currentMovies[currentIndex];
    await sleep(200);
    await saveDecision(movie, status);
    showToast(status === 'interested' ? `Added "${movie.title}" to watchlist ✓` : `Dismissed "${movie.title}"`);
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

// ─── Watchlist view ──────────────────────────────────────────────────
function renderWatchlist() {
    const interested = [];
    userMovies.forEach((m) => {
        if (m.status === 'interested') interested.push(m);
    });

    interested.sort((a, b) => (a.releaseDate || '').localeCompare(b.releaseDate || ''));

    if (interested.length === 0) {
        watchlistContainer.innerHTML = '<div class="empty-state"><p>Your watchlist is empty.</p><p class="hint">Swipe right on movies you want to see!</p></div>';
        return;
    }

    const now = new Date();
    const groups = groupByTimeframe(interested, now);
    let html = '';

    for (const [label, movies] of groups) {
        if (movies.length === 0) continue;
        html += `<h3 class="group-header">${label} <span class="group-count">(${movies.length})</span></h3>`;
        movies.forEach(m => {
            const posterUrl = getImageUrl(m.posterPath, 'w185');
            const releaseFormatted = formatDate(m.releaseDate);
            const isReleasingSoon = isWithinDays(m.releaseDate, 7);
            const isPast = m.releaseDate && new Date(m.releaseDate) <= now;
            const rating = m.voteAverage ? m.voteAverage.toFixed(1) : '—';

            html += `
                <div class="watchlist-item${isReleasingSoon ? ' releasing-soon' : ''}${isPast ? ' now-available' : ''}" data-tmdb-id="${m.tmdbId}">
                    ${posterUrl
                        ? `<img src="${posterUrl}" alt="${m.title}" class="watchlist-poster">`
                        : '<div class="watchlist-poster no-poster-sm">?</div>'}
                    <div class="watchlist-info">
                        <h4>${m.title}</h4>
                        <p class="release-date">${releaseFormatted}</p>
                        ${isPast ? '<span class="badge-available">Now Available</span>' : ''}
                        <div class="watchlist-meta">
                            <span class="score-badge rating small">★ ${rating}</span>
                            ${(m.genres || []).slice(0, 2).map(g => `<span class="genre-badge small">${g}</span>`).join('')}
                        </div>
                    </div>
                    <button class="btn-remove" title="Dismiss" data-action="dismiss" data-tmdb-id="${m.tmdbId}">✕</button>
                </div>
            `;
        });
    }

    watchlistContainer.innerHTML = html;

    watchlistContainer.querySelectorAll('.btn-remove').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.tmdbId);
            const movie = userMovies.get(id);
            if (movie) {
                const movieRef = doc(db, 'users', currentUser.uid, 'movies', String(id));
                await setDoc(movieRef, { ...movie, status: 'dismissed', decidedAt: new Date().toISOString() });
                showToast(`Moved "${movie.title}" to dismissed`);
            }
        });
    });
}

// ─── Dismissed view ──────────────────────────────────────────────────
function renderDismissed() {
    const dismissed = [];
    userMovies.forEach((m) => {
        if (m.status === 'dismissed') dismissed.push(m);
    });

    dismissed.sort((a, b) => (b.decidedAt || '').localeCompare(a.decidedAt || ''));

    if (dismissed.length === 0) {
        dismissedContainer.innerHTML = '<div class="empty-state"><p>No dismissed movies.</p><p class="hint">Movies you pass on will appear here.</p></div>';
        return;
    }

    let html = '<div class="dismissed-grid">';
    dismissed.forEach(m => {
        const posterUrl = getImageUrl(m.posterPath, 'w185');
        html += `
            <div class="dismissed-item" data-tmdb-id="${m.tmdbId}">
                ${posterUrl
                    ? `<img src="${posterUrl}" alt="${m.title}">`
                    : '<div class="no-poster-sm">?</div>'}
                <p class="dismissed-title">${m.title}</p>
                <button class="btn-restore" title="Restore to watchlist" data-tmdb-id="${m.tmdbId}">↩</button>
            </div>
        `;
    });
    html += '</div>';
    dismissedContainer.innerHTML = html;

    dismissedContainer.querySelectorAll('.btn-restore').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = Number(btn.dataset.tmdbId);
            const movie = userMovies.get(id);
            if (movie) {
                const movieRef = doc(db, 'users', currentUser.uid, 'movies', String(id));
                await setDoc(movieRef, { ...movie, status: 'interested', decidedAt: new Date().toISOString() });
                showToast(`Restored "${movie.title}" to watchlist ✓`);
            }
        });
    });
}

// ─── Release notifications ───────────────────────────────────────────
function checkReleaseNotifications() {
    // Only check if permission is granted
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const today = new Date().toISOString().split('T')[0];
    const tomorrow = new Date(Date.now() + 86400000).toISOString().split('T')[0];

    userMovies.forEach(m => {
        if (m.status !== 'interested') return;
        if (!m.releaseDate) return;

        // Check if we already notified for this movie (stored in sessionStorage)
        const notifiedKey = `notified-${m.tmdbId}`;
        if (sessionStorage.getItem(notifiedKey)) return;

        if (m.releaseDate === today) {
            new Notification('Movie Tracker', {
                body: `"${m.title}" releases today!`,
                icon: getImageUrl(m.posterPath, 'w92') || undefined,
                tag: `release-${m.tmdbId}`
            });
            sessionStorage.setItem(notifiedKey, '1');
        } else if (m.releaseDate === tomorrow) {
            new Notification('Movie Tracker', {
                body: `"${m.title}" releases tomorrow!`,
                icon: getImageUrl(m.posterPath, 'w92') || undefined,
                tag: `release-${m.tmdbId}`
            });
            sessionStorage.setItem(notifiedKey, '1');
        }
    });
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
    let dismissCount = 0;
    userMovies.forEach(m => {
        if (m.status === 'interested') watchCount++;
        else if (m.status === 'dismissed') dismissCount++;
    });

    const watchBadge = document.getElementById('badge-watchlist');
    const dismissBadge = document.getElementById('badge-dismissed');

    if (watchCount > 0) {
        watchBadge.textContent = watchCount;
        watchBadge.classList.remove('hidden');
    } else {
        watchBadge.classList.add('hidden');
    }

    if (dismissCount > 0) {
        dismissBadge.textContent = dismissCount;
        dismissBadge.classList.remove('hidden');
    } else {
        dismissBadge.classList.add('hidden');
    }
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

// ─── Notification permission button ─────────────────────────────────
const notifBtn = document.getElementById('btn-notifications');
if (notifBtn) {
    // Hide if already granted or not supported
    if (!('Notification' in window) || Notification.permission === 'granted') {
        notifBtn.classList.add('hidden');
    }
    notifBtn.addEventListener('click', async () => {
        await requestNotificationPermission();
        notifBtn.classList.add('hidden');
    });
}

// ─── Init ────────────────────────────────────────────────────────────
async function init() {
    switchView('discover');
    setupSearch();
    setupFilterTabs();

    cardStack.innerHTML = '<div class="loading"><div class="spinner"></div><p>Loading movies…</p></div>';

    await ensureAuth();
    listenToDecisions();
    await fetchGenres();
    await loadMoreMovies();

    showCurrentCard();
}

init();
