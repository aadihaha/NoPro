const express = require('express');
const { admin } = require('../config/firebase');

const router = express.Router();

// ----------------------------------------------------------------------
// POST /send - Dispatch push notification reminder via Firebase Cloud Messaging
// ----------------------------------------------------------------------
router.post('/send', async (req, res) => {
  try {
    const { fcmToken, title, body, data } = req.body;

    // 1. Validate request body fields
    if (!fcmToken || typeof fcmToken !== 'string' || !fcmToken.trim()) {
      return res.status(400).json({
        success: false,
        error: '"fcmToken" is required and must be a valid non-empty string.',
      });
    }

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        success: false,
        error: '"title" is required and must be a non-empty string.',
      });
    }

    if (!body || typeof body !== 'string' || !body.trim()) {
      return res.status(400).json({
        success: false,
        error: '"body" is required and must be a non-empty string.',
      });
    }

    // 2. Construct FCM Message payload
    const message = {
      token: fcmToken.trim(),
      notification: {
        title: title.trim(),
        body: body.trim(),
      },
    };

    // Include optional custom data payload (values must be strings in FCM)
    if (data && typeof data === 'object') {
      message.data = Object.keys(data).reduce((acc, key) => {
        acc[key] = String(data[key]);
        return acc;
      }, {});
    }

    // 3. Dispatch message via Firebase Admin Messaging
    const messageId = await admin.messaging().send(message);

    // 4. Return 200 OK JSON response
    return res.status(200).json({
      success: true,
      message: 'Reminder notification sent successfully.',
      messageId,
      data: {
        messageId,
        recipientToken: fcmToken.trim(),
        notification: {
          title: title.trim(),
          body: body.trim(),
        },
      },
    });
  } catch (error) {
    console.error('Error dispatching FCM reminder notification:', error);

    const errorCode = error.code || '';
    const errorMessage = error.message || '';

    // Gracefully catch invalid token errors and return 400
    if (
      errorCode.includes('invalid-registration-token') ||
      errorCode.includes('registration-token-not-registered') ||
      errorCode.includes('invalid-argument') ||
      errorMessage.toLowerCase().includes('registration token') ||
      errorMessage.toLowerCase().includes('invalid token') ||
      errorMessage.toLowerCase().includes('not a valid fcm registration token')
    ) {
      return res.status(400).json({
        success: false,
        error: 'Invalid or unregistered FCM token provided.',
        details: errorMessage,
        code: errorCode || 'INVALID_FCM_TOKEN',
      });
    }

    // Server or credential-level failure
    return res.status(500).json({
      success: false,
      error: 'Failed to send reminder push notification.',
      details: errorMessage,
    });
  }
});

module.exports = router;
