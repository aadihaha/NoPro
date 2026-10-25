require('dotenv').config();
const express = require('express');
const cors = require('cors');

const documentRoutes = require('./routes/document');
const roadmapRoutes = require('./routes/roadmap');
const sessionRoutes = require('./routes/sessions');
const taskRoutes = require('./routes/tasks');
const quizRoutes = require('./routes/quizzes');
const reminderRoutes = require('./routes/reminders');

const app = express();
const PORT = process.env.PORT || 5000;

// ----------------------------------------------------------------------
// 1. Global Middleware
// ----------------------------------------------------------------------
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ----------------------------------------------------------------------
// 2. Health Check Route
// ----------------------------------------------------------------------
app.get('/', (req, res) => {
  res.status(200).json({
    status: 'ok',
    app: 'NoPro Backend API',
    uptime: process.uptime(),
    timestamp: new Date().toISOString(),
  });
});

// ----------------------------------------------------------------------
// 3. API Routes
// ----------------------------------------------------------------------
app.use('/api/documents', documentRoutes);
app.use('/api/roadmap', roadmapRoutes);
app.use('/api/sessions', sessionRoutes);
app.use('/api/tasks', taskRoutes);
app.use('/api/quizzes', quizRoutes);
app.use('/api/reminders', reminderRoutes);

// ----------------------------------------------------------------------
// 4. Fallback 404 & Error Handler
// ----------------------------------------------------------------------
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: `Route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  console.error('Unhandled server error:', err);
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal Server Error',
  });
});

// ----------------------------------------------------------------------
// 5. Server Listener
// ----------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`🚀 NoPro backend server running on http://localhost:${PORT}`);
  });
}

module.exports = app;
