const express = require('express');
const { db } = require('../config/firebase');

const router = express.Router();

// ----------------------------------------------------------------------
// Helper: Check database initialization
// ----------------------------------------------------------------------
function ensureDb(res) {
  if (!db) {
    res.status(500).json({
      success: false,
      error: 'Firestore database instance is not initialized. Please configure Firebase credentials.',
    });
    return false;
  }
  return true;
}

// ----------------------------------------------------------------------
// 1. POST / - Create a new Task
// ----------------------------------------------------------------------
router.post('/', async (req, res) => {
  try {
    if (!ensureDb(res)) return;

    const { userId, title, description, subject, topic, planned_duration, due_date } = req.body;

    // 1.1 Validation
    if (!userId || typeof userId !== 'string' || !userId.trim()) {
      return res.status(400).json({
        success: false,
        error: '"userId" is required and must be a non-empty string.',
      });
    }

    if (!title || typeof title !== 'string' || !title.trim()) {
      return res.status(400).json({
        success: false,
        error: '"title" is required and must be a non-empty string.',
      });
    }

    // 1.2 Prepare Task document
    const taskPayload = {
      userId: userId.trim(),
      title: title.trim(),
      description: description ? String(description).trim() : '',
      subject: subject ? String(subject).trim() : 'General',
      topic: topic ? String(topic).trim() : '',
      planned_duration: Number(planned_duration) || 30,
      due_date: due_date ? String(due_date).trim() : null,
      status: 'pending',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    // 1.3 Add to Firestore "Tasks" collection
    const taskRef = await db.collection('Tasks').add(taskPayload);

    return res.status(201).json({
      success: true,
      message: 'Task created successfully.',
      taskId: taskRef.id,
      data: {
        taskId: taskRef.id,
        ...taskPayload,
      },
    });
  } catch (error) {
    console.error('Error creating task:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to create task.',
      details: error.message,
    });
  }
});

// ----------------------------------------------------------------------
// 2. GET /:userId - Retrieve all Tasks for a user ordered by due_date
// ----------------------------------------------------------------------
router.get('/:userId', async (req, res) => {
  try {
    if (!ensureDb(res)) return;

    const { userId } = req.params;
    if (!userId || !userId.trim()) {
      return res.status(400).json({
        success: false,
        error: '"userId" parameter is required.',
      });
    }

    const cleanUserId = userId.trim();
    let snapshot;

    // 2.1 Query Firestore with fallback for missing composite indexes
    try {
      snapshot = await db
        .collection('Tasks')
        .where('userId', '==', cleanUserId)
        .orderBy('due_date', 'asc')
        .get();
    } catch (queryErr) {
      console.warn(`[Firestore Tasks] Index fallback for user "${cleanUserId}":`, queryErr.message);
      snapshot = await db.collection('Tasks').where('userId', '==', cleanUserId).get();
    }

    // 2.2 Format task list
    const tasks = snapshot.docs.map((doc) => ({
      taskId: doc.id,
      ...doc.data(),
    }));

    // In-memory sort fallback (ensures chronological ordering, null due_dates at end)
    tasks.sort((a, b) => {
      if (!a.due_date && !b.due_date) return 0;
      if (!a.due_date) return 1;
      if (!b.due_date) return -1;
      return new Date(a.due_date).getTime() - new Date(b.due_date).getTime();
    });

    return res.status(200).json({
      success: true,
      count: tasks.length,
      userId: cleanUserId,
      data: tasks,
    });
  } catch (error) {
    console.error('Error fetching tasks:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to retrieve tasks.',
      details: error.message,
    });
  }
});

// ----------------------------------------------------------------------
// 3. PUT /:taskId - Update any field of a specific Task
// ----------------------------------------------------------------------
router.put('/:taskId', async (req, res) => {
  try {
    if (!ensureDb(res)) return;

    const { taskId } = req.params;
    if (!taskId || !taskId.trim()) {
      return res.status(400).json({
        success: false,
        error: '"taskId" parameter is required.',
      });
    }

    const taskRef = db.collection('Tasks').doc(taskId.trim());
    const taskSnap = await taskRef.get();

    if (!taskSnap.exists) {
      return res.status(404).json({
        success: false,
        error: `Task with ID "${taskId}" does not exist.`,
      });
    }

    // 3.1 Whitelist allowed update fields
    const allowedFields = [
      'title',
      'description',
      'subject',
      'topic',
      'planned_duration',
      'due_date',
      'status',
    ];

    const updatePayload = {};
    for (const field of allowedFields) {
      if (req.body[field] !== undefined) {
        if (field === 'planned_duration') {
          updatePayload[field] = Number(req.body[field]);
        } else {
          updatePayload[field] = req.body[field];
        }
      }
    }

    if (Object.keys(updatePayload).length === 0) {
      return res.status(400).json({
        success: false,
        error: 'No valid update fields provided.',
      });
    }

    updatePayload.updated_at = new Date().toISOString();

    // 3.2 Update Firestore document
    await taskRef.update(updatePayload);

    // 3.3 Return updated document
    const updatedSnap = await taskRef.get();

    return res.status(200).json({
      success: true,
      message: 'Task updated successfully.',
      taskId: taskRef.id,
      data: {
        taskId: taskRef.id,
        ...updatedSnap.data(),
      },
    });
  } catch (error) {
    console.error('Error updating task:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to update task.',
      details: error.message,
    });
  }
});

// ----------------------------------------------------------------------
// 4. DELETE /:taskId - Delete a specific Task
// ----------------------------------------------------------------------
router.delete('/:taskId', async (req, res) => {
  try {
    if (!ensureDb(res)) return;

    const { taskId } = req.params;
    if (!taskId || !taskId.trim()) {
      return res.status(400).json({
        success: false,
        error: '"taskId" parameter is required.',
      });
    }

    const taskRef = db.collection('Tasks').doc(taskId.trim());
    const taskSnap = await taskRef.get();

    if (!taskSnap.exists) {
      return res.status(404).json({
        success: false,
        error: `Task with ID "${taskId}" does not exist.`,
      });
    }

    await taskRef.delete();

    return res.status(200).json({
      success: true,
      message: 'Task deleted successfully.',
      taskId: taskId.trim(),
    });
  } catch (error) {
    console.error('Error deleting task:', error);
    return res.status(500).json({
      success: false,
      error: 'Failed to delete task.',
      details: error.message,
    });
  }
});

module.exports = router;
