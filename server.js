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

  if (!code) {
    return res.status(400).send('Missing code query parameter');
  }

  try {
    // 1. Exchange code for access token
    const tokenRes = await axios.get(
      'https://graph.facebook.com/v18.0/oauth/access_token',
      {
        params: {
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          redirect_uri: process.env.FB_REDIRECT_URI,
          code,
        },
      }
    );

    const accessToken = tokenRes.data.access_token;

    // 2. Get user profile
    const userRes = await axios.get(
      'https://graph.facebook.com/me',
      {
        params: {
          access_token: accessToken,
          fields: 'id,name,picture',
        },
      }
    );

    const user = userRes.data;

    // 3. Store session in memory
    sessions[user.id] = { accessToken, user };

    // 4. Redirect back to frontend with user ID
    res.redirect(`https://heartbreaksweeper.com?user=${user.id}`);

  } catch (err) {
    console.error('OAuth error:', err.response?.data || err.message);
    res.status(500).send('OAuth failed');
  }
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

// Environment validation on startup
const requiredEnv = ['FB_APP_ID', 'FB_APP_SECRET', 'FB_REDIRECT_URI'];
const missingEnv = requiredEnv.filter((key) => !process.env[key]);
if (missingEnv.length) {
  console.error(`Missing required env vars: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));