# Movie Tracker

A personal movie tracking PWA for browsing upcoming theatrical and streaming releases. Swipe right to add movies to your watchlist, swipe left to dismiss — Tinder-style.

Built with vanilla HTML/CSS/JS, Firebase Firestore for persistence, and the TMDB API for movie data.

## Features

- **Discover feed** — Swipe through upcoming theatrical and streaming releases as cards
- **Search** — Find any movie in the TMDB database with debounced search
- **Source filtering** — Toggle between All, Theatrical, and Streaming releases
- **Rich movie cards** — Poster, title, release date, TMDB rating, popularity score, genres, director, top 5 cast with photos, expandable plot overview, and trailer link
- **Watchlist** — Movies you swipe right on, grouped by release timeframe (This Week / This Month / Later / Now Available)
- **Dismissed archive** — Greyed-out grid of passed movies, with one-tap restore
- **Release notifications** — Browser notifications when watchlisted movies release
- **Offline-ready PWA** — Installable on mobile with service worker caching
- **Viewport-adaptive layout** — Uses `dvh` units so the card and controls fit any mobile screen without scrolling

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Vanilla HTML, CSS, JavaScript (ES modules) |
| Data | [TMDB API](https://www.themoviedb.org/documentation/api) |
| Auth | Firebase Anonymous Authentication |
| Database | Cloud Firestore (`users/{uid}/movies/{tmdbId}`) |
| Hosting | GitHub Pages |

## Project Structure

```
movie-tracker/
├── index.html            # App shell — 3 views + bottom nav
├── style.css             # Cinema-themed styles, mobile-first
├── app.js                # TMDB API, Firebase, swipe gestures, views
├── firebase-config.js    # Firebase project credentials
├── manifest.json         # PWA manifest
└── README.md
```

## Setup

### Prerequisites

1. **TMDB API key** — Register at [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) (free)
2. **Firebase project** — Create at [console.firebase.google.com](https://console.firebase.google.com):
   - Enable **Cloud Firestore** (start in test mode)
   - Enable **Authentication → Anonymous** sign-in
   - Copy your Firebase config object

### Installation

1. Clone the repo:
   ```bash
   git clone https://github.com/<your-username>/movie-tracker.git
   cd movie-tracker
   ```

2. Update `firebase-config.js` with your Firebase project credentials.

3. Update the `TMDB_API_KEY` constant in `app.js` with your TMDB API key.

4. Serve locally:
   ```bash
   python3 -m http.server 8000
   ```

5. Open `http://localhost:8000` in your browser.

### Firestore Security Rules

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /users/{userId}/movies/{movieId} {
      allow read, write: if request.auth != null && request.auth.uid == userId;
    }
  }
}
```

## Usage

| Action | How |
|--------|-----|
| Add to watchlist | Swipe card right, tap ✓, or press → |
| Dismiss | Swipe card left, tap ✕, or press ← |
| Search | Type in the search bar (400ms debounce) |
| Filter source | Tap All / Theatrical / Streaming tabs |
| Expand overview | Tap "Read more" on the card |
| Watch trailer | Tap the ▶ Trailer link |
| Restore dismissed | Hover/tap a dismissed movie and tap ↩ |
| Remove from watchlist | Tap ✕ on a watchlist item |

## API Endpoints Used

- `GET /movie/upcoming` — Upcoming theatrical releases
- `GET /discover/movie` — Streaming releases (filtered by provider IDs)
- `GET /search/movie` — Full-text movie search
- `GET /movie/{id}/credits` — Director and cast
- `GET /movie/{id}/videos` — Trailers (YouTube)
- `GET /genre/movie/list` — Genre ID-to-name mapping

## License

Personal project. TMDB data is provided under the [TMDB Terms of Use](https://www.themoviedb.org/terms-of-use).
