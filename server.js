// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AWS = require('aws-sdk');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' })); // allow multiple base64 images

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
  let allPhotos = [];
  let url = `https://graph.facebook.com/v18.0/me/photos?fields=images,created_time&limit=100&type=${encodeURIComponent(
    type
  )}&access_token=${encodeURIComponent(token)}`;

  while (url) {
    const response = await axios.get(url);
    const data = response.data;
    if (data.error) {
      const error = new Error(data.error.message || 'Facebook API error');
      error.details = data.error;
      throw error;
    }
    const photos = Array.isArray(data.data) ? data.data : [];
    allPhotos = allPhotos.concat(photos);
    console.log(`Facebook ${type} photos page: ${photos.length} (total so far: ${allPhotos.length})`);
    url = data.paging?.next || null;
  }

  console.log(`Facebook ${type} photos total: ${allPhotos.length}`);
  return allPhotos;
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
    const response = await axios.get(
      `https://graph.facebook.com/v18.0/me/photos?fields=images,created_time&limit=50&access_token=${encodeURIComponent(
        token
      )}`
    );
    const data = response.data;
    if (data.error) {
      console.error('Facebook /photos error:', data.error);
      return res.status(500).json({ error: 'Facebook API error', details: data.error });
    }
    res.json(data);
  } catch (error) {
    console.error('Photos error:', error.response?.data || error.message);
    res.status(500).json({ error: error.response?.data?.error?.message || error.message });
  }
});

// 🔥 AI Analyze endpoint: compares refPhoto(s) against user's Facebook photos
app.post('/analyze', async (req, res) => {
  const { token, refPhoto, refPhotos } = req.body;

  // Accept either a single refPhoto string or an array of refPhotos
  const rawPhotos = Array.isArray(refPhotos) && refPhotos.length > 0
    ? refPhotos
    : refPhoto
      ? [refPhoto]
      : [];

  if (!token || !rawPhotos.length) {
    return res.status(400).json({ error: 'Missing token or reference photo(s) in body' });
  }

  try {
    // 1. Convert each refPhoto (data URL) to a validated Buffer
    const refBuffers = [];
    for (let i = 0; i < rawPhotos.length; i++) {
      const base64Data = rawPhotos[i].split(',')[1];
      if (!base64Data) {
        return res.status(400).json({ error: `Reference photo #${i + 1} has an invalid format.` });
      }
      const buf = Buffer.from(base64Data, 'base64');
      const sizeMB = buf.length / (1024 * 1024);
      console.log(`Reference photo #${i + 1} size: ${sizeMB.toFixed(2)} MB`);
      if (sizeMB > 5) {
        return res.status(400).json({
          error: `Reference photo #${i + 1} is too large (${sizeMB.toFixed(1)} MB). Rekognition limit is 5 MB. Please upload a smaller image.`,
        });
      }

      // Pre-validate: make sure Rekognition can detect at least one face
      try {
        const detectRes = await rekognition
          .detectFaces({ Image: { Bytes: buf }, Attributes: ['DEFAULT'] })
          .promise();
        const faceCount = (detectRes.FaceDetails || []).length;
        console.log(`Reference photo #${i + 1}: ${faceCount} face(s) detected`);
        if (faceCount === 0) {
          return res.status(400).json({
            error: `No face detected in reference photo #${i + 1}. Upload a clear, front-facing photo with good lighting.`,
          });
        }
      } catch (detectErr) {
        console.error(`DetectFaces error on ref photo #${i + 1}:`, detectErr.code, detectErr.message);
        return res.status(500).json({
          error: `Could not validate reference photo #${i + 1} with AWS Rekognition.`,
          details: detectErr.message,
          code: detectErr.code,
        });
      }

      refBuffers.push(buf);
    }

    console.log(`Using ${refBuffers.length} reference photo(s) for comparison`);

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
          refPhotosUsed: refBuffers.length,
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
    let compareErrors = 0;
    let noFaceInTarget = 0;

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

    // 3. For each Facebook photo, compare against ALL reference photos — keep the best score
    for (const photo of photos) {
      const bestImage = photo.images?.[0];
      if (!bestImage || !bestImage.source) {
        skippedPhotos += 1;
        continue;
      }

      try {
        const imgRes = await axios.get(bestImage.source, { responseType: 'arraybuffer' });
        const imgBuffer = Buffer.from(imgRes.data);

        if (imgBuffer.length > 5 * 1024 * 1024) {
          console.warn(`Skipping photo ${photo.id}: ${(imgBuffer.length / 1024 / 1024).toFixed(1)} MB exceeds 5 MB limit`);
          skippedPhotos += 1;
          continue;
        }

        comparedPhotos += 1;
        let bestSimilarity = 0;

        for (const refBuf of refBuffers) {
          try {
            const rekRes = await rekognition
              .compareFaces({
                SourceImage: { Bytes: refBuf },
                TargetImage: { Bytes: imgBuffer },
                SimilarityThreshold: 40,
              })
              .promise();

            const faceMatch = (rekRes.FaceMatches || [])[0];
            if (faceMatch && faceMatch.Similarity > bestSimilarity) {
              bestSimilarity = faceMatch.Similarity;
            }
          } catch (cmpErr) {
            console.error(`Rekognition compare error (photo ${photo.id}, ref): [${cmpErr.code}] ${cmpErr.message}`);
            compareErrors += 1;
            if (cmpErr.code === 'InvalidParameterException' && /no face/i.test(cmpErr.message)) {
              noFaceInTarget += 1;
            }
            if (isAwsAuthError(cmpErr)) {
              awsAuthError = cmpErr;
              break;
            }
            if (isAwsPermissionError(cmpErr)) {
              return res.status(500).json({
                error: 'AWS Rekognition permission denied',
                details: cmpErr.message,
                fix: 'Attach an IAM policy allowing rekognition:CompareFaces on *.',
              });
            }
          }
        }

        if (awsAuthError) break;

        console.log(`Photo ${photo.id}: bestSimilarity=${bestSimilarity.toFixed(1)}`);
        if (bestSimilarity > 0) {
          matches.push({
            id: photo.id,
            url: bestImage.source,
            confidence: Math.round(bestSimilarity),
            date: photo.created_time || null,
          });
        }
      } catch (err) {
        console.error(`Error processing photo ${photo.id}: [${err.code || ''}] ${err.message}`);
        rekognitionErrors += 1;
        if (isAwsAuthError(err)) {
          awsAuthError = err;
          break;
        }
      }
    }

    if (awsAuthError) {
      return res.status(500).json({
        error: 'AWS Rekognition authentication failed',
        details: awsAuthError.message,
        fix: 'Update AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION in Render.',
      });
    }

    matches.sort((left, right) => (right.confidence || 0) - (left.confidence || 0));

    let message = `Scanned ${comparedPhotos} Facebook photos using ${refBuffers.length} reference photo(s).`;
    if (matches.length) {
      message += ` Found ${matches.length} match(es).`;
    } else {
      if ((rekognitionErrors + compareErrors) > 0 && (rekognitionErrors + compareErrors) >= comparedPhotos) {
        message = `Tried to scan ${comparedPhotos} photos but comparisons failed (${compareErrors} compare errors, ${noFaceInTarget} no-face-in-target). Try different reference photos.`;
      } else if (comparedPhotos > 0) {
        message = `Scanned ${comparedPhotos} photos with ${refBuffers.length} reference(s) but found no face matches above 40% (${compareErrors} compare errors, ${noFaceInTarget} no-face-in-target). Try clearer front-facing reference photos.`;
      } else {
        message = 'Facebook photos were found, but none could be processed.';
      }
    }

    res.json({
      matches,
      message,
      diagnostics: {
        refPhotosUsed: refBuffers.length,
        uploadedPhotos: uploadedPhotos.length,
        taggedPhotos: taggedPhotos.length,
        totalUniquePhotos: photos.length,
        comparedPhotos,
        skippedPhotos,
        rekognitionErrors,
        compareErrors,
        noFaceInTarget,
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

