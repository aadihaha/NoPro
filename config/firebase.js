const { initializeApp, getApps, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const { getMessaging } = require('firebase-admin/messaging');

// Compatible admin object for FieldValue, server timestamps, and messaging
const admin = {
  firestore: {
    FieldValue,
  },
  messaging: () => {
    try {
      return getMessaging();
    } catch (e) {
      throw new Error(`Firebase Messaging initialization error: ${e.message}`);
    }
  },
};

let db;

try {
  if (!getApps().length) {
    if (
      process.env.FIREBASE_PROJECT_ID &&
      process.env.FIREBASE_CLIENT_EMAIL &&
      process.env.FIREBASE_PRIVATE_KEY
    ) {
      initializeApp({
        credential: cert({
          projectId: process.env.FIREBASE_PROJECT_ID,
          clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
        }),
      });
    } else {
      initializeApp({
        projectId: process.env.FIREBASE_PROJECT_ID || 'nopro-app',
      });
    }
  }
  db = getFirestore();
} catch (error) {
  console.warn('[Firebase Config] Warning initializing Firebase Admin:', error.message);
  db = null;
}

module.exports = { admin, db, FieldValue };
