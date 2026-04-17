/**
 * Serves Firebase client config as a JS file.
 * Replaces the deleted firebase-config.local.js (gitignored credentials).
 * Firebase config is non-secret by design — security lives in Firebase Rules.
 */
const express = require("express");
const router = express.Router();

router.get("/config.js", (req, res) => {
  const apiKey         = process.env.FIREBASE_API_KEY         || "";
  const authDomain     = process.env.FIREBASE_AUTH_DOMAIN     || "";
  const projectId      = process.env.FIREBASE_PROJECT_ID      || "";
  const storageBucket  = process.env.FIREBASE_STORAGE_BUCKET  || "";
  const messagingSenderId = process.env.FIREBASE_MESSAGING_SENDER_ID || "";
  const appId          = process.env.FIREBASE_APP_ID          || "";
  const measurementId  = process.env.FIREBASE_MEASUREMENT_ID  || "";

  // Dev bypass: ALLOW_NO_AUTH=true skips Firebase and opens the app directly.
  // Use this for local development when Firebase credentials aren't set up yet.
  if (!apiKey || !authDomain || !projectId) {
    const allowNoAuth = process.env.ALLOW_NO_AUTH === "true";
    return res.type("application/javascript").send(
      allowNoAuth
        ? "window.__DEV_NO_AUTH__ = true;\n"
        : "// Firebase env vars not set — see .env.example\n"
    );
  }

  const config = JSON.stringify({
    apiKey, authDomain, projectId, storageBucket,
    messagingSenderId, appId, measurementId,
  });

  res.type("application/javascript").send(
    `window.__FIREBASE_CONFIG__ = ${config};\n`
  );
});

module.exports = router;
