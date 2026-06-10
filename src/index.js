require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const paymentRoutes = require('./routes/payment');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, '..', 'public')));

// API routes
app.use('/api', paymentRoutes);

// Fallback to index.html for SPA-like behavior
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`\n  🚀 ALEF-BET Payment Server running on port ${PORT}`);
  console.log(`  📍 Environment: ${process.env.KEEPZ_ENV || 'dev'}`);
  console.log(`  🌐 Frontend: http://localhost:${PORT}`);
  console.log(`  💡 API Health: http://localhost:${PORT}/api/health\n`);
});
