require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

let groq;
try {
    const Groq = require('groq-sdk');
    groq = new Groq({ apiKey: process.env.GROQ_API_KEY || '' });
} catch (e) {
    console.log("Groq SDK error:", e);
}

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

// --- IN-MEMORY TASK TRACKER ---
let tasks = [];
app.get('/api/tasks', (req, res) => res.json(tasks));
app.post('/api/tasks', (req, res) => {
    const newTask = {
        id: 'task_' + Date.now(),
        title: req.body.title || 'Untitled Task',
        priority: req.body.priority || 'Medium priority',
        date: req.body.date || new Date().toISOString(),
        status: req.body.status || 'pending',
        completed: false
    };
    tasks.unshift(newTask);
    res.status(201).json(newTask);
});
app.patch('/api/tasks/:id', (req, res) => {
    const task = tasks.find(t => t.id === req.params.id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (req.body.completed !== undefined) task.completed = req.body.completed;
    if (req.body.status !== undefined) task.status = req.body.status;
    if (req.body.completedAt !== undefined) task.completedAt = req.body.completedAt;
    res.json(task);
});
app.delete('/api/tasks/:id', (req, res) => {
    tasks = tasks.filter(t => t.id !== req.params.id);
    res.status(204).send();
});

// --- IN-MEMORY SESSIONS (FOCUS TIMER) TRACKER ---
let sessions = [];
app.get('/api/sessions', (req, res) => res.json(sessions));
app.post('/api/sessions', (req, res) => {
    const newSession = {
        id: 'session_' + Date.now(),
        duration: req.body.duration || 25,
        type: req.body.type || 'Focus',
        date: req.body.date || new Date().toISOString()
    };
    sessions.unshift(newSession);
    res.status(201).json(newSession);
});
app.delete('/api/sessions/:id', (req, res) => {
    sessions = sessions.filter(s => s.id !== req.params.id);
    res.status(204).send();
});

// --- IN-MEMORY HABIT STREAKS TRACKER ---
let habits = [];
app.get('/api/habits', (req, res) => res.json(habits));
app.post('/api/habits', (req, res) => {
    const newHabit = {
        id: 'habit_' + Date.now(),
        name: req.body.name || 'New Habit',
        streak: 0,
        lastCompleted: null,
        createdAt: new Date().toISOString()
    };
    habits.unshift(newHabit);
    res.status(201).json(newHabit);
});
app.put('/api/habits/:id/complete', (req, res) => {
    const habit = habits.find(h => h.id === req.params.id);
    if (!habit) return res.status(404).json({ error: 'Habit not found' });
    habit.streak += 1;
    habit.lastCompleted = new Date().toISOString();
    res.json(habit);
});
app.delete('/api/habits/:id', (req, res) => {
    habits = habits.filter(h => h.id !== req.params.id);
    res.status(204).send();
});

// --- IN-MEMORY NOTES TRACKER ---
let notes = [];
app.get('/api/notes', (req, res) => res.json(notes));
app.post('/api/notes', (req, res) => {
    const newNote = {
        id: 'note_' + Date.now(),
        title: req.body.title || 'Untitled',
        content: req.body.content || '',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString()
    };
    notes.unshift(newNote);
    res.status(201).json(newNote);
});
app.put('/api/notes/:id', (req, res) => {
    const note = notes.find(n => n.id === req.params.id);
    if (!note) return res.status(404).json({ error: 'Note not found' });
    note.title = req.body.title || note.title;
    note.content = req.body.content || note.content;
    note.updatedAt = new Date().toISOString();
    res.json(note);
});
app.delete('/api/notes/:id', (req, res) => {
    notes = notes.filter(n => n.id !== req.params.id);
    res.status(204).send();
});

// --- TIMER SETTINGS ---
let timerSettings = { focus: { h: 0, m: 25, s: 0 }, shortBreak: { h: 0, m: 5, s: 0 }, longBreak: { h: 0, m: 15, s: 0 } };
app.get('/api/timer-settings', (req, res) => res.json(timerSettings));
app.put('/api/timer-settings', (req, res) => {
    timerSettings = { ...timerSettings, ...req.body };
    res.json(timerSettings);
});

// --- ALARMS ---
let alarms = [];
app.get('/api/alarms', (req, res) => res.json(alarms));
app.post('/api/alarms', (req, res) => {
    const newAlarm = { id: 'alarm_' + Date.now(), title: req.body.title, time: req.body.time };
    alarms.push(newAlarm);
    res.status(201).json(newAlarm);
});
app.delete('/api/alarms/:id', (req, res) => {
    alarms = alarms.filter(a => a.id !== req.params.id);
    res.status(204).send();
});

// --- USER SETTINGS & RESET ---
let userSettings = { theme: 'dark', soundEnabled: true };
app.get('/api/user/settings', (req, res) => res.json(userSettings));
app.put('/api/user/settings', (req, res) => {
    userSettings = { ...userSettings, ...req.body };
    res.json(userSettings);
});
app.post('/api/user/reset', (req, res) => {
    tasks = []; sessions = []; habits = []; notes = []; libraryFiles = []; alarms = [];
    timerSettings = { focus: { h: 0, m: 25, s: 0 }, shortBreak: { h: 0, m: 5, s: 0 }, longBreak: { h: 0, m: 15, s: 0 } };
    res.json({ success: true });
});

// --- RAG LIBRARY ---
let libraryFiles = [];
app.get('/api/library', (req, res) => res.json(libraryFiles));
app.post('/api/library', upload.single('file'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file received.' });
        const fileName = req.file.originalname;
        let extractedText = "";

        try {
            if (req.file.mimetype === 'application/pdf' || fileName.toLowerCase().endsWith('.pdf')) {
                const parseFunc = typeof pdfParse === 'function' ? pdfParse : pdfParse.default || pdfParse.pdfParse;
                const pdfData = await parseFunc(req.file.buffer);
                extractedText = pdfData.text.substring(0, 15000); 
            } else {
                extractedText = `Document Title: ${fileName}. (Please summarize core mechanics and specific methodologies related to this title).`;
            }
        } catch (parseErr) {
            extractedText = `Document Title: ${fileName}. (Please summarize core mechanics and specific methodologies related to this title).`;
        }

        if (!extractedText || extractedText.trim().length < 50) {
             extractedText = `Document Title: ${fileName}. (Text was unreadable. Generate a plan based on the title alone).`;
        }

        const newFile = {
            id: 'file_' + Date.now(),
            name: fileName,
            size: req.file.size,
            type: req.file.mimetype,
            content: extractedText,
            dateAdded: new Date().toISOString()
        };
        
        libraryFiles.unshift(newFile);
        res.json(newFile);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});
app.delete('/api/library/:id', (req, res) => {
    libraryFiles = libraryFiles.filter(f => f.id !== req.params.id);
    res.status(204).send();
});

// --- RAG GENERATOR ---
app.post('/api/rag/study-plan', async (req, res) => {
    try {
        const { text, title } = req.body;
        const docText = text || "Core concepts, principles, and structured learning material.";
        const docTitle = title || "Custom Study Material";

        const prompt = `Create a highly specific, 3-day study schedule based ONLY on the actual content provided below. 
Do not use generic phrases like "Understand core principles". Instead, reference the exact terminology, algorithms, formulas, or historical facts mentioned in the text.
Document Title: ${docTitle}
Document Content: ${docText}

Output ONLY valid JSON matching this exact structure:
{
  "title": "Study Plan: ${docTitle}",
  "schedule": [
    {"day": "Day 1", "focus": "Specific Topic from text", "tasks": ["Specific Task 1", "Specific Task 2", "Specific Task 3"]},
    {"day": "Day 2", "focus": "Another Specific Topic", "tasks": ["Specific Task 1", "Specific Task 2", "Specific Task 3"]},
    {"day": "Day 3", "focus": "Review & Practice", "tasks": ["Specific Task 1", "Specific Task 2", "Specific Task 3"]}
  ]
}`;

        let studyPlan;
        if (groq) {
            try {
                const modelsList = await groq.models.list();
                let availableModels = modelsList.data.map(m => m.id);
                
                availableModels = availableModels.filter(m => !m.includes('guard') && !m.includes('whisper') && !m.includes('tool-use'));
                availableModels.sort((a, b) => {
                    const score = (m) => (m.includes('llama-3') || m.includes('llama3') ? 3 : m.includes('mixtral') ? 2 : m.includes('gemma') ? 1 : 0);
                    return score(b) - score(a);
                });

                for (const modelId of availableModels) {
                    try {
                        const chatCompletion = await groq.chat.completions.create({
                            messages: [{ role: 'user', content: prompt }],
                            model: modelId 
                        });
                        
                        let responseText = chatCompletion.choices[0].message.content.replace(/```json/g, '').replace(/```/g, '').trim();
                        const jsonStart = responseText.indexOf('{');
                        const jsonEnd = responseText.lastIndexOf('}');
                        if (jsonStart !== -1 && jsonEnd !== -1) responseText = responseText.substring(jsonStart, jsonEnd + 1);
                        
                        let parsedData = JSON.parse(responseText);
                        
                        if (parsedData && Array.isArray(parsedData.schedule)) {
                            studyPlan = parsedData;
                            break; 
                        } else {
                            throw new Error("Invalid JSON structure returned by model.");
                        }
                    } catch (groqErr) {
                        continue;
                    }
                }
            } catch (listErr) {
                console.warn("Failed to fetch Groq models:", listErr.message);
            }
        }

        if (!studyPlan || !studyPlan.schedule) {
            studyPlan = {
                "title": `Study Plan: ${docTitle}`,
                "schedule": [
                    {"day": "Day 1", "focus": "Introduction & Core Concepts", "tasks": ["Review fundamental definitions", "Study structural hierarchy", "Analyze introductory examples"]},
                    {"day": "Day 2", "focus": "Advanced Mechanics", "tasks": ["Explore complex interactions", "Examine practical models", "Work through problem sets"]},
                    {"day": "Day 3", "focus": "Review & Testing", "tasks": ["Synthesize overarching themes", "Review summary notes", "Perform self-assessment"]}
                ]
            };
        }

        res.json(studyPlan);
    } catch (err) {
        res.status(500).json({ error: "Failed to generate plan." });
    }
});

app.listen(PORT, () => console.log(`🚀 NoPro backend running on port ${PORT}`));