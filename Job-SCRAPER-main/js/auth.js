/**
 * AUTH module — Firebase email sign-in only (no guest mode).
 */
(() => {
  let currentUser = null;
  let unsubscribeListener = null;
  let initRetries = 0;
  const MAX_INIT_RETRIES = 12;
  const THEME_KEY = 'job_hunt_hq_theme';
  const THEME_EVENT = 'jobhunt-theme-changed';

  const authPhrases = [
    '"Consistency turns effort into offers."',
    '"Each application is a step closer to your role."',
    '"Discipline today creates opportunities tomorrow."',
    '"One focused hour beats a day of uncertainty."'
  ];

  function getEl(id) { return document.getElementById(id); }

  function showAppLayout() {
    const layout = getEl('app-layout');
    const authScreen = getEl('auth-screen');
    if (layout) layout.classList.remove('hidden');
    if (authScreen) authScreen.classList.add('hidden');
  }

  function showAuthScreen() {
    const layout = getEl('app-layout');
    const authScreen = getEl('auth-screen');
    if (layout) layout.classList.add('hidden');
    if (authScreen) authScreen.classList.remove('hidden');
  }

  function setLoginBusy(isBusy, message = '') {
    const btn = getEl('auth-login-btn');
    const email = getEl('auth-email-input');
    const password = getEl('auth-password-input');
    if (btn) {
      btn.disabled = isBusy;
      btn.innerHTML = isBusy
        ? '<span>Signing in...</span>'
        : '<span>Sign in</span><span class="btn-auth-arrow" aria-hidden="true">\u2192</span>';
    }
    if (email) email.disabled = isBusy;
    if (password) password.disabled = isBusy;
    setLoginError(message);
  }

  function readTheme() {
    try { return localStorage.getItem(THEME_KEY) || 'light'; } catch { return 'light'; }
  }

  function writeTheme(theme) {
    try { localStorage.setItem(THEME_KEY, theme); } catch { /* ignore */ }
  }

  function broadcastTheme(theme) {
    window.dispatchEvent(new CustomEvent(THEME_EVENT, { detail: { theme } }));
  }

  function syncThemeIcon(theme) {
    const icon = getEl('auth-theme-icon');
    if (!icon) return;
    icon.textContent = theme === 'dark' ? '\uD83C\uDF19' : '\u2600';
    icon.classList.remove('icon-pop');
    void icon.offsetWidth;
    icon.classList.add('icon-pop');
  }

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme);
    syncThemeIcon(theme);
  }

  function bindAuthThemeToggle() {
    const toggle = getEl('auth-theme-toggle');
    if (!toggle || toggle.dataset.bound === 'true') return;
    toggle.dataset.bound = 'true';
    applyTheme(readTheme());
    toggle.addEventListener('click', () => {
      const current = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
      const next = current === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      writeTheme(next);
      if (window.JobHuntApp && typeof window.JobHuntApp.setTheme === 'function') {
        window.JobHuntApp.setTheme(next);
      } else {
        broadcastTheme(next);
      }
    });
  }

  function bindThemeSyncListeners() {
    if (window.__jobHuntThemeSyncBound) return;
    window.__jobHuntThemeSyncBound = true;
    window.addEventListener('storage', (event) => {
      if (event.key === THEME_KEY && event.newValue && (event.newValue === 'light' || event.newValue === 'dark')) {
        applyTheme(event.newValue);
      }
    });
    window.addEventListener(THEME_EVENT, (event) => {
      const t = event?.detail?.theme;
      if (t === 'light' || t === 'dark') applyTheme(t);
    });
  }

  function setLoginError(message) {
    const errorEl = getEl('auth-error');
    if (!errorEl) return;
    if (!message) { errorEl.textContent = ''; errorEl.classList.add('hidden'); return; }
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
  }

  function rotateMotivation() {
    const quote = getEl('auth-quote');
    if (!quote) return;
    quote.textContent = authPhrases[Math.floor(Math.random() * authPhrases.length)];
  }

  function bindLoginForm() {
    const form = getEl('auth-login-form');
    if (!form || form.dataset.bound === 'true') return;
    form.dataset.bound = 'true';
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const email = (getEl('auth-email-input')?.value || '').trim();
      const password = getEl('auth-password-input')?.value || '';
      if (!email || !email.includes('@')) { setLoginError('Enter a valid email address.'); return; }
      if (!password || password.length < 6) { setLoginError('Password must be at least 6 characters.'); return; }
      try {
        setLoginBusy(true);
        await FirebaseAPI.auth.signInWithEmail(email, password);
      } catch (error) {
        const code = error?.code || '';
        let message = 'Sign in failed. Please try again.';
        if (code === 'auth/invalid-credential' || code === 'auth/wrong-password') message = 'Invalid email or password.';
        else if (code === 'auth/user-not-found') message = 'No account found for this email.';
        else if (code === 'auth/too-many-requests') message = 'Too many attempts. Please wait and retry.';
        setLoginBusy(false, message);
      }
    });
  }

  function initAuth() {
    bindAuthThemeToggle();
    bindThemeSyncListeners();
    rotateMotivation();

    if (typeof FirebaseAPI === 'undefined' || !FirebaseAPI.isReady || !FirebaseAPI.isReady()) {
      initRetries += 1;
      if (initRetries > MAX_INIT_RETRIES) {
        setLoginBusy(false, 'Firebase is not initialized. Check firebase-config.local.js.');
        return;
      }
      setTimeout(initAuth, 500);
      return;
    }

    initRetries = 0;
    bindLoginForm();

    FirebaseAPI.auth.onAuthStateChanged(async (user) => {
      if (window.JobHuntApp && typeof window.JobHuntApp.setAuthUser === 'function') {
        window.JobHuntApp.setAuthUser(user || null);
      }
      if (user && !user.isAnonymous) {
        currentUser = user;
        showAppLayout();
        setLoginBusy(false, '');
        loadUserData(user.uid);
        setupRealtimeListener(user.uid);
      } else {
        currentUser = null;
        if (unsubscribeListener) { unsubscribeListener(); unsubscribeListener = null; }
        showAuthScreen();
        setLoginBusy(false, '');
      }
    });
  }

  async function loadUserData(userId) {
    try {
      const applications = await FirebaseAPI.db.loadApplications(userId);
      if (window.JobHuntApp && window.JobHuntApp.init) {
        window.JobHuntApp.init(userId, applications);
      }
      const settings = await FirebaseAPI.db.loadSettings(userId);
      if (settings.theme && window.JobHuntApp?.setTheme) window.JobHuntApp.setTheme(settings.theme);
      if (settings.weeklyGoal && window.JobHuntApp?.setWeeklyGoal) window.JobHuntApp.setWeeklyGoal(settings.weeklyGoal);
    } catch (error) {
      console.error('Failed to load user data:', error);
      if (window.JobHuntApp?.init) window.JobHuntApp.init(userId, []);
    }
  }

  function setupRealtimeListener(userId) {
    if (unsubscribeListener) unsubscribeListener();
    unsubscribeListener = FirebaseAPI.db.listenToApplications(userId, (applications) => {
      if (window.JobHuntApp?.setApplications) window.JobHuntApp.setApplications(applications);
    });
  }

  window.AuthManager = {
    init: initAuth,
    getCurrentUser: () => currentUser,
    isSignedIn: () => !!currentUser
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(initAuth, 100));
  } else {
    setTimeout(initAuth, 100);
  }
})();
