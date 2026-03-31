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

// Cache OAuth callback work by authorization code so duplicate hits can reuse
// the first result instead of re-exchanging the same one-time code.
const oauthCallbacks = new Map(); // code -> { timestamp, promise }
const CODE_TTL_MS = 5 * 60 * 1000;

function pruneOauthCallbacks() {
  const now = Date.now();
  for (const [code, entry] of oauthCallbacks.entries()) {
    if (now - entry.timestamp > CODE_TTL_MS) {
      oauthCallbacks.delete(code);
    }
  }
}

function buildFrontendRedirect(frontendUrl, params = {}) {
  const redirectTarget = new URL(frontendUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') {
      redirectTarget.searchParams.set(key, value);
    }
  }
  return redirectTarget.toString();
}

async function fetchFacebookPhotoSet(token, type) {
  const response = await fetch(
    `https://graph.facebook.com/v18.0/me/photos?fields=images,created_time&limit=100&type=${encodeURIComponent(
      type
    )}&access_token=${encodeURIComponent(token)}`
  );
  const data = await response.json();
  if (data.error) {
    const error = new Error(data.error.message || 'Facebook API error');
    error.details = data.error;
    throw error;
  }
  return Array.isArray(data.data) ? data.data : [];
}

// Facebook OAuth callback (legacy, not really used by frontend)
app.get('/auth/facebook/callback', async (req, res) => {
  const { code } = req.query;
  res.json({ status: 'Callback received', code });
});

// Generic auth callback endpoint used by frontend
app.get('/auth/callback', async (req, res) => {
  res.set({
    'Cache-Control': 'no-store, no-cache, max-age=0, must-revalidate',
    Pragma: 'no-cache',
    Expires: '0',
  });

  const code = req.query.code;
  console.log('Callback code:', code);

  const envRedirect = process.env.FB_REDIRECT_URI || '';
  const normalizedRedirect = envRedirect.trim().replace(/^"|"$/g, '');
  const fallbackRedirect = `${req.protocol}://${req.get('host')}/auth/callback`;
  const redirectUri = normalizedRedirect || fallbackRedirect;
  const frontendUrl = process.env.FRONTEND_URL || 'https://heartbreaksweeper.com';

  if (!code) {
    return res.status(400).send('Missing code query parameter');
  }

  pruneOauthCallbacks();

  const existingCallback = oauthCallbacks.get(code);
  if (existingCallback) {
    console.warn('Duplicate OAuth code received — reusing first callback result');
    try {
      const redirectUrl = await existingCallback.promise;
      return res.redirect(redirectUrl);
    } catch (err) {
      return res.redirect(
        buildFrontendRedirect(frontendUrl, {
          auth_error: 'login_failed',
          message: 'Facebook login failed. Try again.',
        })
      );
    }
  }

  const oauthEnv = ['FB_APP_ID', 'FB_APP_SECRET', 'FB_REDIRECT_URI'];
  const missingOauthEnv = oauthEnv.filter((key) => !process.env[key]);
  if (missingOauthEnv.length) {
    return res.status(500).json({
      error: 'OAuth is not configured on the server',
      missing: missingOauthEnv,
    });
  }

  const callbackPromise = (async () => {
    // Validate redirect URI before using it in OAuth token exchange.
    try {
      new URL(redirectUri);
    } catch {
      throw {
        status: 500,
        body: {
          error: 'OAuth is not configured on the server',
          details: 'FB_REDIRECT_URI is not a valid absolute URL',
          callback: redirectUri,
        },
      };
    }

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

    const userRes = await axios.get('https://graph.facebook.com/me', {
      params: {
        access_token: accessToken,
        fields: 'id,name,picture',
      },
    });

    const user = userRes.data;
    sessions[user.id] = { accessToken, user };

    return buildFrontendRedirect(frontendUrl, {
      user: user.id,
      userId: user.id,
      id: user.id,
      token: accessToken,
      access_token: accessToken,
      fbToken: accessToken,
    });
  })();

  oauthCallbacks.set(code, {
    timestamp: Date.now(),
    promise: callbackPromise,
  });

  try {
    const redirectUrl = await callbackPromise;
    res.redirect(redirectUrl);
  } catch (err) {
    const oauthError = err.response?.data || { message: err.message };
    console.error('OAuth error:', oauthError);

    // If the code was already used (loop case), redirect frontend home so user can try again cleanly.
    const fbError = oauthError?.error || oauthError;
    const fbCode = fbError?.code;
    const fbSubcode = fbError?.error_subcode;
    if (fbCode === 100 && fbSubcode === 36009) {
      return res.redirect(
        buildFrontendRedirect(frontendUrl, {
          auth_error: 'code_used',
          message: 'Facebook retried an old login. Please start one fresh login attempt.',
        })
      );
    }

    if (err.status && err.body) {
      return res.status(err.status).json(err.body);
    }

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

    // 2. Fetch both uploaded and tagged photo sets.
    let uploadedPhotos = [];
    let taggedPhotos = [];
    try {
      [uploadedPhotos, taggedPhotos] = await Promise.all([
        fetchFacebookPhotoSet(token, 'uploaded'),
        fetchFacebookPhotoSet(token, 'tagged'),
      ]);
    } catch (error) {
      console.error('Facebook /me/photos error:', error.details || error.message);
      return res.status(500).json({
        error: 'Facebook API error',
        details: error.details || error.message,
      });
    }

    const photos = Array.from(
      new Map([...uploadedPhotos, ...taggedPhotos].map((photo) => [photo.id, photo])).values()
    );

    if (!photos.length) {
      return res.json({
        matches: [],
        message:
          'Facebook returned 0 accessible photos. This usually means the account has no uploaded/tagged photos available to this app yet, or the app lacks access for this Facebook user.',
        diagnostics: {
          uploadedPhotos: uploadedPhotos.length,
          taggedPhotos: taggedPhotos.length,
          scannedPhotos: 0,
        },
      });
    }

    const matches = [];
    let awsAuthError = null;
    let comparedPhotos = 0;
    let skippedPhotos = 0;
    let rekognitionErrors = 0;

    const isAwsAuthError = (err) => {
      const message = String(err?.message || '').toLowerCase();
      const code = String(err?.code || '').toLowerCase();
      return (
        message.includes('security token included in the request is invalid') ||
        message.includes('the security token included in the request is invalid') ||
        code === 'unrecognizedclientexception' ||
        code === 'invalidsignatureexception'
      );
    };

    const isAwsPermissionError = (err) => {
      const message = String(err?.message || '').toLowerCase();
      const code = String(err?.code || '').toLowerCase();
      return (
        code === 'accessdeniedexception' ||
        message.includes('is not authorized to perform') ||
        message.includes('identity-based policy allows no')
      );
    };

    // 3. For each photo, compare faces using Rekognition
    for (const photo of photos) {
      const bestImage = photo.images?.[0];
      if (!bestImage || !bestImage.source) {
        skippedPhotos += 1;
        continue;
      }

      try {
        // Download the photo bytes
        const imgRes = await fetch(bestImage.source);
        const imgArrayBuffer = await imgRes.arrayBuffer();
        const imgBuffer = Buffer.from(imgArrayBuffer);
        comparedPhotos += 1;

        // Compare faces
        const rekRes = await rekognition
          .compareFaces({
            SourceImage: { Bytes: refBuffer },
            TargetImage: { Bytes: imgBuffer },
            SimilarityThreshold: 40,
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
        rekognitionErrors += 1;
        if (isAwsAuthError(err)) {
          awsAuthError = err;
          break;
        }
        if (isAwsPermissionError(err)) {
          return res.status(500).json({
            error: 'AWS Rekognition permission denied',
            details: err.message,
            fix: 'Attach an IAM policy to this AWS user/role allowing rekognition:CompareFaces (and optionally rekognition:DetectFaces) on *.',
          });
        }
        // continue with next photo
      }
    }

    if (awsAuthError) {
      return res.status(500).json({
        error: 'AWS Rekognition authentication failed',
        details: awsAuthError.message,
        fix: 'Update AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION in Render. If using temporary credentials, also set AWS_SESSION_TOKEN.',
      });
    }

    matches.sort((left, right) => (right.confidence || 0) - (left.confidence || 0));

    let message = `Scanned ${comparedPhotos} Facebook photos.`;
    if (!matches.length) {
      message =
        comparedPhotos > 0
          ? `Scanned ${comparedPhotos} Facebook photos but found no face matches above 40% similarity. Try a clearer front-facing reference photo.`
          : 'Facebook photos were found, but none could be processed into face comparisons.';
    }

    // 4. Return matches in the format your frontend expects
    res.json({
      matches,
      message,
      diagnostics: {
        uploadedPhotos: uploadedPhotos.length,
        taggedPhotos: taggedPhotos.length,
        totalUniquePhotos: photos.length,
        comparedPhotos,
        skippedPhotos,
        rekognitionErrors,
      },
    });
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

