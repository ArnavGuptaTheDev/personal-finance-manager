// Loaded blocking in <head> of /login/: if this tab was signed in, hide the page until
// the session check in login.astro redirects or reveals it (no sign-in card flash).
try {
  if (sessionStorage.getItem('pfm.me') && !/[?&]error=/.test(location.search)) document.documentElement.classList.add('auth-check');
} catch (e) {}
