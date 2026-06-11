/**
 * Firebase config for SAP Job Automator.
 * Extended from tracker with library + cached JD operations.
 */
const defaultFirebaseConfig = {
  apiKey: "AIzaSyDG0VBXMrUdxzpw3Hwwrsr_oRtiVg_vSuM",
  authDomain: "jobs-progress-tracker.firebaseapp.com",
  projectId: "jobs-progress-tracker",
  storageBucket: "jobs-progress-tracker.firebasestorage.app",
  messagingSenderId: "556518693770",
  appId: "1:556518693770:web:2df595285bf3ec199f0673",
  measurementId: "G-8JNFN5X2RE"
};

const firebaseConfig =
  typeof window !== "undefined" &&
  window.__FIREBASE_CONFIG__ &&
  typeof window.__FIREBASE_CONFIG__ === "object"
    ? window.__FIREBASE_CONFIG__
    : defaultFirebaseConfig;

let app, auth, db;

function initializeFirebase() {
  try {
    if (typeof firebase === 'undefined') {
      console.error('Firebase SDK not loaded.');
      return false;
    }
    const hasPlaceholder = Object.values(firebaseConfig).some((v) => String(v).includes('YOUR_'));
    if (hasPlaceholder) {
      console.error('Firebase config placeholders detected.');
      return false;
    }
    app = firebase.initializeApp(firebaseConfig);
    auth = firebase.auth();
    db = firebase.firestore();
    db.enablePersistence({ synchronizeTabs: true }).catch((err) => {
      console.warn('Firestore persistence error:', err.code);
    });
    console.log('Firebase initialized');
    return true;
  } catch (error) {
    console.error('Firebase initialization error:', error);
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
// AUTH HELPERS
// ═══════════════════════════════════════════════════════════════

function signOut() {
  return auth.signOut();
}

function signInWithEmail(email, password) {
  return auth.setPersistence(firebase.auth.Auth.Persistence.LOCAL)
    .then(() => auth.signInWithEmailAndPassword(email, password))
    .then((result) => result.user);
}

function getCurrentUser() {
  return auth.currentUser;
}

function onAuthStateChanged(callback) {
  return auth.onAuthStateChanged(callback);
}

// ═══════════════════════════════════════════════════════════════
// APPLICATION CRUD (existing tracker operations)
// ═══════════════════════════════════════════════════════════════

async function saveApplicationToFirestore(userId, application) {
  const appRef = db.collection('users').doc(userId)
    .collection('applications').doc(application.id);
  await appRef.set({
    ...application,
    createdAt: application.createdAt || new Date().toISOString(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return true;
}

async function loadApplicationsFromFirestore(userId) {
  const mapDoc = (doc) => ({
    id: doc.id,
    ...doc.data(),
    createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
    updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || doc.data().updatedAt
  });
  const baseRef = db.collection('users').doc(userId).collection('applications');
  try {
    const snapshot = await baseRef.orderBy('updatedAt', 'desc').get();
    return snapshot.docs.map(mapDoc);
  } catch {
    const fallback = await baseRef.get();
    return fallback.docs.map(mapDoc)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
  }
}

function listenToApplications(userId, callback) {
  const mapDoc = (doc) => ({
    id: doc.id,
    ...doc.data(),
    createdAt: doc.data().createdAt?.toDate?.()?.toISOString() || doc.data().createdAt,
    updatedAt: doc.data().updatedAt?.toDate?.()?.toISOString() || doc.data().updatedAt
  });
  const baseRef = db.collection('users').doc(userId).collection('applications');
  const onSnap = (snapshot) => {
    const apps = snapshot.docs.map(mapDoc)
      .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
    callback(apps);
  };
  let fallbackUnsub = null;
  const primaryUnsub = baseRef.orderBy('updatedAt', 'desc').onSnapshot(onSnap, () => {
    if (!fallbackUnsub) {
      fallbackUnsub = baseRef.onSnapshot(onSnap, (err) => console.error('Listener error:', err));
    }
  });
  return () => { primaryUnsub(); if (fallbackUnsub) fallbackUnsub(); };
}

async function deleteApplicationFromFirestore(userId, applicationId) {
  await db.collection('users').doc(userId)
    .collection('applications').doc(applicationId).delete();
  return true;
}

async function saveUserSettings(userId, settings) {
  try {
    await db.collection('users').doc(userId).set({
      settings,
      updatedAt: firebase.firestore.FieldValue.serverTimestamp()
    }, { merge: true });
    return true;
  } catch (error) {
    console.error('Settings save error:', error);
    return false;
  }
}

async function loadUserSettings(userId) {
  try {
    const doc = await db.collection('users').doc(userId).get();
    return doc.exists ? (doc.data().settings || {}) : {};
  } catch {
    return {};
  }
}

// ═══════════════════════════════════════════════════════════════
// LIBRARY OPERATIONS (NEW — foundation, approved, insights)
// ═══════════════════════════════════════════════════════════════

function libraryRef(userId) {
  return db.collection('users').doc(userId).collection('library');
}

async function saveFoundationDoc(userId, doc) {
  await libraryRef(userId).doc('foundation').collection('docs').doc(doc.id).set(doc);
  return true;
}

async function loadFoundationDocs(userId) {
  const snap = await libraryRef(userId).doc('foundation').collection('docs').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function saveApprovedGeneration(userId, gen) {
  await libraryRef(userId).doc('approved').collection('docs').doc(gen.id).set({
    ...gen,
    approvedAt: gen.approvedAt || new Date().toISOString(),
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return true;
}

async function loadApprovedGenerations(userId) {
  const snap = await libraryRef(userId).doc('approved').collection('docs').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

async function updateGenerationOutcome(userId, genId, outcome) {
  const ref = libraryRef(userId).doc('approved').collection('docs').doc(genId);
  const weightDelta = outcome === 'interview' ? 0.5 : outcome === 'offer' ? 0.8 : outcome === 'rejected' ? -0.3 : 0;
  const doc = await ref.get();
  const currentWeight = doc.exists ? (doc.data().weight || 1.0) : 1.0;
  const newWeight = Math.max(0.2, Math.min(2.0, currentWeight + weightDelta));
  await ref.update({
    outcome,
    outcomeDate: new Date().toISOString(),
    weight: newWeight,
    updatedAt: firebase.firestore.FieldValue.serverTimestamp()
  });
  return newWeight;
}

async function saveDomainInsight(userId, domain, insight) {
  await libraryRef(userId).doc('insights').collection('domains').doc(domain).set({
    ...insight,
    domain,
    lastUpdated: firebase.firestore.FieldValue.serverTimestamp()
  }, { merge: true });
  return true;
}

async function loadDomainInsights(userId) {
  const snap = await libraryRef(userId).doc('insights').collection('domains').get();
  return snap.docs.map(d => ({ domain: d.id, ...d.data() }));
}

async function saveLibraryConfig(userId, config) {
  await libraryRef(userId).doc('config').set(config, { merge: true });
  return true;
}

async function loadLibraryConfig(userId) {
  const doc = await libraryRef(userId).doc('config').get();
  return doc.exists ? doc.data() : null;
}

// ═══════════════════════════════════════════════════════════════
// CACHED JOB DESCRIPTIONS
// ═══════════════════════════════════════════════════════════════

async function saveCachedJD(userId, jd) {
  await db.collection('users').doc(userId)
    .collection('cached_jds').doc(jd.id).set({
    ...jd,
    cachedAt: jd.cachedAt || new Date().toISOString()
  }, { merge: true });
  return true;
}

async function loadCachedJD(userId, reqId) {
  const doc = await db.collection('users').doc(userId)
    .collection('cached_jds').doc(reqId).get();
  return doc.exists ? { id: doc.id, ...doc.data() } : null;
}

async function loadAllCachedJDs(userId) {
  const snap = await db.collection('users').doc(userId)
    .collection('cached_jds').get();
  return snap.docs.map(d => ({ id: d.id, ...d.data() }));
}

// ═══════════════════════════════════════════════════════════════
// EXPORT API
// ═══════════════════════════════════════════════════════════════

window.FirebaseAPI = {
  initialize: initializeFirebase,
  isReady: () => !!auth && !!db,
  auth: {
    signInWithEmail,
    signOut,
    getCurrentUser,
    onAuthStateChanged
  },
  db: {
    saveApplication: saveApplicationToFirestore,
    loadApplications: loadApplicationsFromFirestore,
    listenToApplications,
    deleteApplication: deleteApplicationFromFirestore,
    saveSettings: saveUserSettings,
    loadSettings: loadUserSettings
  },
  library: {
    saveFoundationDoc,
    loadFoundationDocs,
    saveApprovedGeneration,
    loadApprovedGenerations,
    updateGenerationOutcome,
    saveDomainInsight,
    loadDomainInsights,
    saveLibraryConfig,
    loadLibraryConfig
  },
  jd: {
    saveCachedJD,
    loadCachedJD,
    loadAllCachedJDs
  }
};

// Auto-initialize
if (typeof firebase !== 'undefined') {
  initializeFirebase();
} else {
  const check = setInterval(() => {
    if (typeof firebase !== 'undefined') {
      clearInterval(check);
      initializeFirebase();
    }
  }, 100);
  setTimeout(() => clearInterval(check), 5000);
}
