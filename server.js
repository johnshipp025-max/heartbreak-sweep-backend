// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AWS = require('aws-sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // allow base64 images

// AWS Rekognition setup
AWS.config.update({
  region: process.env.AWS_REGION || 'us-east-1',
  // AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY are read from env automatically
});
const rekognition = new AWS.Rekognition();

// Temporary storage (not used heavily now, but kept if needed later)
const sessions = {};

// Facebook OAuth callback (legacy, not really used by frontend)
app.get('/auth/facebook/callback', async (req, res) => {
  const { code } = req.query;
  res.json({ status: 'Callback received', code });
});

// Generic auth callback endpoint used by frontend
app.get('/auth/callback', async (req, res) => {
  const code = req.query.code;
  console.log('Callback code:', code);

  const envRedirect = process.env.FB_REDIRECT_URI || '';
  const normalizedRedirect = envRedirect.trim().replace(/^"|"$/g, '');
  const fallbackRedirect = `${req.protocol}://${req.get('host')}/auth/callback`;
  const redirectUri = normalizedRedirect || fallbackRedirect;

  if (!code) {
    return res.status(400).send('Missing code query parameter');
  }

  const oauthEnv = ['FB_APP_ID', 'FB_APP_SECRET', 'FB_REDIRECT_URI'];
  const missingOauthEnv = oauthEnv.filter((key) => !process.env[key]);
  if (missingOauthEnv.length) {
    return res.status(500).json({
      error: 'OAuth is not configured on the server',
      missing: missingOauthEnv,
    });
  }

  try {
    // Validate redirect URI before using it in OAuth token exchange.
    try {
      new URL(redirectUri);
    } catch {
      return res.status(500).json({
        error: 'OAuth is not configured on the server',
        details: 'FB_REDIRECT_URI is not a valid absolute URL',
        callback: redirectUri,
      });
    }

    // 1. Exchange code for access token
    const tokenRes = await axios.get(
      'https://graph.facebook.com/v18.0/oauth/access_token',
      {
        params: {
          client_id: process.env.FB_APP_ID,
          client_secret: process.env.FB_APP_SECRET,
          redirect_uri: redirectUri,
          code,
        },
      }
    );

    const accessToken = tokenRes.data.access_token;

    // 2. Get user profile
    const userRes = await axios.get('https://graph.facebook.com/me', {
      params: {
        access_token: accessToken,
        fields: 'id,name,picture',
      },
    });

    const user = userRes.data;

    // 3. Store session in memory (optional)
    sessions[user.id] = { accessToken, user };

    // 4. Redirect back to frontend with user ID and token
    const frontendUrl = process.env.FRONTEND_URL || 'https://heartbreaksweeper.com';
    const redirectUrl = `${frontendUrl}?user=${encodeURIComponent(
      user.id
    )}&token=${encodeURIComponent(accessToken)}`;

    res.redirect(redirectUrl);
  } catch (err) {
    const oauthError = err.response?.data || { message: err.message };
    console.error('OAuth error:', oauthError);
    res.status(500).json({
      error: 'OAuth failed',
      details: oauthError,
      hint: 'Check Facebook app settings and ensure FB_REDIRECT_URI exactly matches the login redirect URL.',
      callback: redirectUri,
    });
  }
});

// Get raw photos from Facebook (used by /analyze or direct listing)
app.get('/photos', async (req, res) => {
  const { token } = req.query;

  if (!token) {
    return res.status(400).json({ error: 'Missing token query parameter' });
  }

  try {
    const response = await fetch(
      `https://graph.facebook.com/v18.0/me/photos?fields=images,created_time&limit=50&access_token=${encodeURIComponent(
        token
      )}`
    );
    const data = await response.json();
    if (data.error) {
      console.error('Facebook /photos error:', data.error);
      return res.status(500).json({ error: 'Facebook API error', details: data.error });
    }
    res.json(data);
  } catch (error) {
    console.error('Photos error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// 🔥 AI Analyze endpoint: compares refPhoto against user's Facebook photos
app.post('/analyze', async (req, res) => {
  const { token, refPhoto } = req.body;

  if (!token || !refPhoto) {
    return res.status(400).json({ error: 'Missing token or refPhoto in body' });
  }

  try {
    // 1. Convert refPhoto (data URL) to Buffer
    const base64Data = refPhoto.split(',')[1];
    if (!base64Data) {
      return res.status(400).json({ error: 'Invalid refPhoto format' });
    }
    const refBuffer = Buffer.from(base64Data, 'base64');

    // 2. Fetch user's photos from Facebook
    const photosRes = await fetch(
      `https://graph.facebook.com/v18.0/me/photos?fields=images,created_time&limit=50&access_token=${encodeURIComponent(
        token
      )}`
    );
    const photosData = await photosRes.json();

    if (photosData.error) {
      console.error('Facebook /me/photos error:', photosData.error);
      return res.status(500).json({ error: 'Facebook API error', details: photosData.error });
    }

    const photos = Array.isArray(photosData.data) ? photosData.data : [];
    const matches = [];

    // 3. For each photo, compare faces using Rekognition
    for (const photo of photos) {
      const bestImage = photo.images?.[0];
      if (!bestImage || !bestImage.source) continue;

      try {
        // Download the photo bytes
        const imgRes = await fetch(bestImage.source);
        const imgArrayBuffer = await imgRes.arrayBuffer();
        const imgBuffer = Buffer.from(imgArrayBuffer);

        // Compare faces
        const rekRes = await rekognition
          .compareFaces({
            SourceImage: { Bytes: refBuffer },
            TargetImage: { Bytes: imgBuffer },
            SimilarityThreshold: 70, // adjust as needed
          })
          .promise();

        const faceMatch = (rekRes.FaceMatches || [])[0];
        if (faceMatch && faceMatch.Similarity) {
          matches.push({
            id: photo.id,
            url: bestImage.source,
            confidence: Math.round(faceMatch.Similarity),
            date: photo.created_time || null,
          });
        }
      } catch (err) {
        console.error(`Rekognition error for photo ${photo.id}:`, err.message);
        // continue with next photo
      }
    }

    // 4. Return matches in the format your frontend expects
    res.json({ matches });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

// 🔥 Delete endpoint: deletes selected photos from Facebook
app.post('/delete', async (req, res) => {
  const { token, ids } = req.body;

  if (!token || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Missing token or ids in body' });
  }

  try {
    const results = [];

    for (const id of ids) {
      try {
        const delRes = await axios.delete(
          `https://graph.facebook.com/v18.0/${encodeURIComponent(id)}`,
          {
            params: { access_token: token },
          }
        );
        results.push({ id, success: true, response: delRes.data });
      } catch (err) {
        console.error(`Delete error for ${id}:`, err.response?.data || err.message);
        results.push({
          id,
          success: false,
          error: err.response?.data || err.message,
        });
      }
    }

    res.json({ deleted: results });
  } catch (err) {
    console.error('Delete endpoint error:', err.message);
    res.status(500).json({ error: 'Delete failed', details: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Heartbreak Sweep API Running',
    endpoints: ['/auth/callback', '/photos', '/analyze', '/delete'],
  });
});

// Facebook OAuth vars are validated in /auth/callback so the server can still boot for health checks.
const requiredOauthEnv = ['FB_APP_ID', 'FB_APP_SECRET', 'FB_REDIRECT_URI'];
const missingOauthEnv = requiredOauthEnv.filter((key) => !process.env[key]);
if (missingOauthEnv.length) {
  console.warn(
    `Warning: Missing OAuth env vars: ${missingOauthEnv.join(', ')}. /auth/callback will return an error until these are set.`
  );
}

// Optional: warn if AWS env vars missing (but don't hard-exit)
const awsEnv = ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_REGION'];
const missingAws = awsEnv.filter((key) => !process.env[key]);
if (missingAws.length) {
  console.warn(
    `Warning: Missing AWS env vars: ${missingAws.join(
      ', '
    )}. /analyze will fail until these are set.`
  );
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

