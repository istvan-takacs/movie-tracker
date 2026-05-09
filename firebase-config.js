const firebaseConfig = {
    apiKey: "AIzaSyAWZ5nEbBg4dbFHNRX6mIez4jeeNt1dmZg",
    authDomain: "movie-tracker-19d76.firebaseapp.com",
    projectId: "movie-tracker-19d76",
    storageBucket: "movie-tracker-19d76.firebasestorage.app",
    messagingSenderId: "1015296500783",
    appId: "1:1015296500783:web:b78f41375c9320bf96d2da"
  };

  // Google OAuth Web Client ID for One Tap auto sign-in.
  // Find this in: Firebase Console → Authentication → Sign-in method → Google → Web client ID
  const googleClientId = "";

  // OMDb API key for IMDb + Rotten Tomatoes scores.
  // Free tier (1000 req/day): https://www.omdbapi.com/apikey.aspx
  const omdbApiKey = "fdb8cf16";

  export { firebaseConfig, googleClientId, omdbApiKey };