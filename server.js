const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
app.use(cors());
app.use(express.json());

// Temporary storage (will reset when server restarts)
const sessions = {};

// Facebook OAuth callback
app.get('/auth/facebook/callback', async (req, res) => {
  const { code } = req.query;
  // This would exchange code for token
  res.json({ status: 'Callback received', code });
});

// Generic auth callback endpoint
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  console.log('Callback code:', code);

  // Continue your token exchange logic here
  res.send('Callback received');
});

// Get photos endpoint
app.get('/photos', async (req, res) => {
  const { token } = req.query;
  
  try {
    const response = await fetch(`https://graph.facebook.com/v18.0/me/photos?fields=images,link&limit=50&access_token=${token}`);
    const data = await response.json();
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({ 
    status: 'Heartbreak Sweep API Running',
    endpoints: ['/auth/facebook/callback', '/photos']
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));