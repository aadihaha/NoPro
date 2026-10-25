const express = require('express');
const firebaseConfig = require('../config/firebase');

const db = firebaseConfig.db;

// Ensure admin.firestore.FieldValue compatibility across firebase-admin versions
let FieldValue;
try {
  ({ FieldValue } = require('firebase-admin/firestore'));
} catch {
  FieldValue = firebaseConfig.FieldValue || firebaseConfig.admin?.firestore?.FieldValue;
}

const admin = firebaseConfig.admin || {
  firestore: {
    FieldValue,
  },
};

const router = express.Router();

// ----------------------------------------------------------------------
// 1. POST /start - Start a new Focus Session
// ----------------------------------------------------------------------
router.post('/start', async (req, res) => {
  try {
    const { userId, taskId, planned_duration } = req.body;

    // 1.1 Validation
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({
        success: false,
        error: '"userId" is required and must be a non-empty string.',
      });
    }

    const duration = Number(planned_duration);
    if (isNaN(duration) || duration <= 0) {
      return res.status(400).json({
        success: false,
        error: '"planned_duration" is required and must be a positive number of minutes.',
      });
    }

    if (!db) {
      return res.status(500).json({
        success: false,
        error: 'Firestore database instance is not initialized. Please verify Firebase credentials.',
      });
    }

    // 1.2 Prepare session document data
    const sessionPayload = {
      userId: userId.trim(),
      taskId: taskId ? String(taskId).trim() : null,
      planned_duration: duration,
      start_time: admin.firestore.FieldValue.serverTimestamp(),
      status: 'in-progress',
      created_at: new Date().toISOString(),
    };

    // 1.3 Add document to the "Sessions" collection in Firestore
    const sessionRef = await db.collection('Sessions').add(sessionPayload);

    return res.status(200).json({
      success: true,
      message: 'Focus session started successfully.',
      sessionId: sessionRef.id,
      data: {
        sessionId: sessionRef.id,
        userId: userId.trim(),
        taskId: sessionPayload.taskId,
        planned_duration: duration,
        status: 'in-progress',
      },
    });
  } catch (error) {
    console.error('Error starting focus session:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to start focus session.',
      details: error.message,
    });
  }
});

// ----------------------------------------------------------------------
// 2. POST /end - End/Complete or Abort a Focus Session
// ----------------------------------------------------------------------
router.post('/end', async (req, res) => {
  try {
    const { sessionId, userId, abort_reason, confidence_score } = req.body;

    // 2.1 Validation
    if (!sessionId || typeof sessionId !== 'string' || !sessionId.trim()) {
      return res.status(400).json({
        success: false,
        error: '"sessionId" is required.',
      });
    }

    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({
        success: false,
        error: '"userId" is required.',
      });
    }

    if (confidence_score !== undefined && confidence_score !== null) {
      const score = Number(confidence_score);
      if (!Number.isInteger(score) || score < 1 || score > 5) {
        return res.status(400).json({
          success: false,
          error: '"confidence_score" must be an integer between 1 and 5.',
        });
      }
    }

    if (!db) {
      return res.status(500).json({
        success: false,
        error: 'Firestore database instance is not initialized. Please verify Firebase credentials.',
      });
    }

    // 2.2 Retrieve existing session from Firestore
    const sessionRef = db.collection('Sessions').doc(sessionId.trim());
    const sessionDoc = await sessionRef.get();

    if (!sessionDoc.exists) {
      return res.status(404).json({
        success: false,
        error: `Session with ID "${sessionId}" does not exist.`,
      });
    }

    const sessionData = sessionDoc.data();

    // 2.3 Verify ownership
    if (sessionData.userId !== userId.trim()) {
      return res.status(403).json({
        success: false,
        error: 'Forbidden: You do not have permission to modify this session.',
      });
    }

    // 2.4 Guard against re-completing finished sessions
    if (sessionData.status === 'completed' || sessionData.status === 'aborted') {
      return res.status(400).json({
        success: false,
        error: `Session has already been marked as ${sessionData.status}.`,
      });
    }

    // 2.5 Calculate actual duration_minutes
    const now = new Date();
    let startTime;
    if (sessionData.start_time && typeof sessionData.start_time.toDate === 'function') {
      startTime = sessionData.start_time.toDate();
    } else if (sessionData.start_time && sessionData.start_time._seconds) {
      startTime = new Date(sessionData.start_time._seconds * 1000);
    } else if (sessionData.created_at) {
      startTime = new Date(sessionData.created_at);
    } else {
      startTime = now;
    }

    const elapsedMs = Math.max(0, now.getTime() - startTime.getTime());
    const durationMinutes = Math.max(0, Math.round(elapsedMs / (1000 * 60)));

    // 2.6 Determine status (aborted if abort_reason provided, otherwise completed)
    const isAborted = Boolean(
      abort_reason && typeof abort_reason === 'string' && abort_reason.trim().length > 0
    );
    const finalStatus = isAborted ? 'aborted' : 'completed';

    // 2.7 Construct update payload
    const updatePayload = {
      end_time: admin.firestore.FieldValue.serverTimestamp(),
      duration_minutes: durationMinutes,
      status: finalStatus,
      updated_at: now.toISOString(),
    };

    if (isAborted) {
      updatePayload.abort_reason = abort_reason.trim();
    }

    if (confidence_score !== undefined && confidence_score !== null) {
      updatePayload.confidence_score = Number(confidence_score);
    }

    // 2.8 Update Firestore document
    await sessionRef.update(updatePayload);

    // 2.9 Return 200 JSON confirmation response
    return res.status(200).json({
      success: true,
      message: `Focus session marked as ${finalStatus} and saved successfully.`,
      sessionId: sessionRef.id,
      data: {
        sessionId: sessionRef.id,
        userId: userId.trim(),
        taskId: sessionData.taskId || null,
        planned_duration: sessionData.planned_duration,
        duration_minutes: durationMinutes,
        status: finalStatus,
        abort_reason: updatePayload.abort_reason || null,
        confidence_score: updatePayload.confidence_score ?? null,
      },
    });
  } catch (error) {
    console.error('Error ending focus session:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to end focus session.',
      details: error.message,
    });
  }
});

module.exports = router;
