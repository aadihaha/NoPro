import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { db } from './config/firebase.js';
import apiRoutes from './routes/api.js'; // Import your modular API routes

dotenv.config();

const app = express();

// Middleware
app.use(cors({
    origin: true,
    credentials: true
}));
app.use(express.json());

// Health Check Endpoint
app.get('/', (req, res) => {
  res.status(200).json({ status: 'active', message: 'NoPro Backend & Firebase DB are online!' });
});

// ==========================================
// Mount Modular API Routes
// ==========================================
// This routes all requests starting with /api (e.g., /api/tasks, /api/sessions, /api/stats/focus) 
// directly to your routes/api.js file.
app.use('/api', apiRoutes);

// Start Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`NoPro server running on port ${PORT}`);
});