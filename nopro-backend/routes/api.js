import express from 'express';
import { db } from '../config/firebase.js';
import { queryRelevantChunks } from '../utils/vectorSearch.js';

const router = express.Router();

const formatDoc = (doc) => ({ id: doc.id, ...doc.data() });

/* ==========================================================================
   1. TASK ENDPOINTS
   ========================================================================== */

router.get('/tasks', async (req, res) => {
    try {
        const snapshot = await db.collection('tasks').orderBy('createdAt', 'desc').get();
        const tasks = snapshot.docs.map(formatDoc);
        return res.json(tasks);
    } catch (err) {
        console.error('Error fetching tasks:', err);
        return res.status(500).json({ message: 'Failed to fetch tasks' });
    }
});

router.post('/tasks', async (req, res) => {
    try {
        const { title, priority, dueDate } = req.body;
        if (!title) {
            return res.status(400).json({ message: 'Task title is required.' });
        }

        const newTask = {
            title,
            priority: priority || 'medium',
            dueDate: dueDate || null,
            completed: false,
            completedAt: null,
            createdAt: new Date().toISOString()
        };

        const docRef = await db.collection('tasks').add(newTask);
        return res.status(201).json({ id: docRef.id, ...newTask });
    } catch (err) {
        console.error('Error adding task:', err);
        return res.status(500).json({ message: 'Failed to add task' });
    }
});

router.patch('/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const updates = req.body;

        const taskRef = db.collection('tasks').doc(id);
        await taskRef.update(updates);

        const updatedDoc = await taskRef.get();
        return res.json(formatDoc(updatedDoc));
    } catch (err) {
        console.error('Error updating task:', err);
        return res.status(500).json({ message: 'Failed to update task' });
    }
});

router.delete('/tasks/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await db.collection('tasks').doc(id).delete();
        return res.status(204).send();
    } catch (err) {
        console.error('Error deleting task:', err);
        return res.status(500).json({ message: 'Failed to delete task' });
    }
});


/* ==========================================================================
   2. FOCUS SESSION ENDPOINTS
   ========================================================================== */

router.post('/sessions', async (req, res) => {
    try {
        const {
            mode,
            targetDurationSeconds,
            actualDurationSeconds,
            startedAt,
            endedAt,
            completed
        } = req.body;

        const newSession = {
            mode: mode || 'focus',
            targetDurationSeconds: targetDurationSeconds || 0,
            actualDurationSeconds: actualDurationSeconds || 0,
            startedAt: startedAt || Date.now(),
            endedAt: endedAt || Date.now(),
            completed: completed ?? false
        };

        const docRef = await db.collection('sessions').add(newSession);
        return res.status(201).json({ id: docRef.id, ...newSession });
    } catch (err) {
        console.error('Error saving session:', err);
        return res.status(500).json({ message: 'Failed to save session' });
    }
});


/* ==========================================================================
   3. STATS ENDPOINTS
   ========================================================================== */

router.get('/stats/focus', async (req, res) => {
    try {
        const { from, to } = req.query;
        const snapshot = await db.collection('sessions')
            .where('completed', '==', true)
            .get();

        const dailyMinutes = {};

        snapshot.forEach(doc => {
            const session = doc.data();
            const dateStr = new Date(session.endedAt).toISOString().split('T')[0];
            
            if ((!from || dateStr >= from) && (!to || dateStr <= to)) {
                const minutes = Math.round((session.actualDurationSeconds || 0) / 60);
                dailyMinutes[dateStr] = (dailyMinutes[dateStr] || 0) + minutes;
            }
        });

        const result = Object.keys(dailyMinutes).map(date => ({
            date,
            minutes: dailyMinutes[date]
        }));

        return res.json(result);
    } catch (err) {
        console.error('Error fetching focus stats:', err);
        return res.status(500).json({ message: 'Failed to fetch focus stats' });
    }
});

router.get('/stats/tasks', async (req, res) => {
    try {
        const { from, to } = req.query;
        const snapshot = await db.collection('tasks')
            .where('completed', '==', true)
            .get();

        const dailyCounts = {};

        snapshot.forEach(doc => {
            const task = doc.data();
            const dateStr = task.completedAt;
            
            if (dateStr && (!from || dateStr >= from) && (!to || dateStr <= to)) {
                dailyCounts[dateStr] = (dailyCounts[dateStr] || 0) + 1;
            }
        });

        const result = Object.keys(dailyCounts).map(date => ({
            date,
            count: dailyCounts[date]
        }));

        return res.json(result);
    } catch (err) {
        console.error('Error fetching task stats:', err);
        return res.status(500).json({ message: 'Failed to fetch task stats' });
    }
});


/* ==========================================================================
   4. AI & VECTOR SEARCH ENDPOINT (PINECONE)
   ========================================================================== */

router.post('/search/vector', async (req, res) => {
    try {
        const { topic, userId, isGlobal } = req.body;
        const results = await queryRelevantChunks(
            topic || "Chemical Bonding", 
            userId || "test_user", 
            isGlobal ?? true
        );
        return res.status(200).json({ success: true, results });
    } catch (err) {
        console.error('Error executing vector search:', err);
        return res.status(500).json({ success: false, error: err.message });
    }
});


/* ==========================================================================
   5. TIMER SETTINGS & STUBS
   ========================================================================== */

router.get('/timer-settings', async (req, res) => {
    try {
        const doc = await db.collection('settings').doc('timer').get();
        if (!doc.exists) {
            const defaultSettings = {
                focus: { h: 0, m: 25, s: 0 },
                shortBreak: { h: 0, m: 5, s: 0 },
                longBreak: { h: 0, m: 15, s: 0 }
            };
            await db.collection('settings').doc('timer').set(defaultSettings);
            return res.json(defaultSettings);
        }
        return res.json(doc.data());
    } catch (err) {
        console.error('Error fetching timer settings:', err);
        return res.status(500).json({ message: 'Failed to fetch timer settings' });
    }
});

router.put('/timer-settings', async (req, res) => {
    try {
        const newSettings = req.body;
        await db.collection('settings').doc('timer').set(newSettings, { merge: true });
        return res.json(newSettings);
    } catch (err) {
        console.error('Error updating timer settings:', err);
        return res.status(500).json({ message: 'Failed to save timer settings' });
    }
});

// Stubs for frontend initial load
router.get('/habits', (req, res) => res.json([]));
router.get('/notes', (req, res) => res.json([]));
router.get('/alarms', (req, res) => res.json([]));
router.get('/library', (req, res) => res.json([]));
router.get('/user/settings', (req, res) => res.json({ theme: 'dark' }));

export default router;