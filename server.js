// server.js — v1.0.1
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AWS = require('aws-sdk');
const sharp = require('sharp');

// Stripe setup (uses STRIPE_SECRET_KEY env var)
const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

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

// Background scan jobs storage
const scanJobs = new Map(); // jobId -> { status, progress, matches, error, ... }
const JOB_TTL_MS = 30 * 60 * 1000; // 30 min — clean up old jobs
function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of scanJobs.entries()) {
    if (now - job.createdAt > JOB_TTL_MS) scanJobs.delete(id);
  }
}
function generateJobId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Cache OAuth callback work by authorization code so duplicate hits can reuse
// the first result instead of re-exchanging the same one-time code.
const oauthCallbacks = new Map(); // code -> { timestamp, promise, redirectUrl, reuses }
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CODE_REUSES = 3;

// Also cache successful tokens so we can recover from code-reuse errors
const tokenCache = new Map(); // accessToken -> { timestamp, redirectUrl }
const TOKEN_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
let lastSuccessfulRedirectUrl = null; // emergency fallback for rapid re-auth

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
  // Request tags as a nested edge with sub-fields (tags.fields(name))
  const fields = 'images,created_time,from,tags.fields(name)';
  let url = `https://graph.facebook.com/v18.0/me/photos?fields=${encodeURIComponent(fields)}&limit=100&type=${encodeURIComponent(
    type
  )}&access_token=${encodeURIComponent(token)}`;

  // If tags field causes a 400, retry without it
  let retryWithoutTags = false;

  while (url) {
    let response;
    try {
      response = await axios.get(url);
    } catch (fetchErr) {
      if (!retryWithoutTags && fetchErr.response?.status === 400) {
        console.warn(`Facebook rejected tags field for ${type} photos, retrying without tags`);
        retryWithoutTags = true;
        const fieldsNoTags = 'images,created_time,from';
        url = `https://graph.facebook.com/v18.0/me/photos?fields=${encodeURIComponent(fieldsNoTags)}&limit=100&type=${encodeURIComponent(
          type
        )}&access_token=${encodeURIComponent(token)}`;
        continue;
      }
      throw fetchErr;
    }
    const data = response.data;
    if (data.error) {
      const error = new Error(data.error.message || 'Facebook API error');
      error.details = data.error;
      throw error;
    }
    const photos = Array.isArray(data.data) ? data.data : [];
    allPhotos = allPhotos.concat(photos.map(p => ({ ...p, _type: type })));
    console.log(`Facebook ${type} photos page: ${photos.length} (total so far: ${allPhotos.length})`);
    url = data.paging?.next || null;
  }

  console.log(`Facebook ${type} photos total: ${allPhotos.length}`);
  return allPhotos;
}

// Fetch photos from user's own Facebook albums (catches photos that
// don't appear in uploaded/tagged sets, e.g. album-only or shared posts)
async function fetchFacebookAlbumPhotos(token) {
  const allPhotos = [];
  const seenIds = new Set();
  const fields = 'images,created_time,from,tags.fields(name)';

  // 1. Get list of user's albums
  let albumsUrl = `https://graph.facebook.com/v18.0/me/albums?fields=id,name&limit=50&access_token=${encodeURIComponent(token)}`;
  const albumIds = [];
  try {
    while (albumsUrl) {
      const res = await axios.get(albumsUrl);
      const data = res.data;
      if (data.error) break;
      (data.data || []).forEach(a => albumIds.push(a.id));
      albumsUrl = data.paging?.next || null;
    }
  } catch (e) {
    console.warn('fetchFacebookAlbumPhotos: could not list albums:', e.message);
    return [];
  }

  console.log(`fetchFacebookAlbumPhotos: found ${albumIds.length} albums`);

  // 2. For each album fetch its photos (up to 5 albums in parallel)
  const ALBUM_CONCURRENCY = 5;
  for (let i = 0; i < albumIds.length; i += ALBUM_CONCURRENCY) {
    const chunk = albumIds.slice(i, i + ALBUM_CONCURRENCY);
    await Promise.all(chunk.map(async (albumId) => {
      let photoUrl = `https://graph.facebook.com/v18.0/${encodeURIComponent(albumId)}/photos?fields=${encodeURIComponent(fields)}&limit=100&access_token=${encodeURIComponent(token)}`;
      try {
        while (photoUrl) {
          const res = await axios.get(photoUrl);
          const data = res.data;
          if (data.error) break;
          for (const p of (data.data || [])) {
            if (!seenIds.has(p.id)) {
              seenIds.add(p.id);
              allPhotos.push({ ...p, _type: 'uploaded' });
            }
          }
          photoUrl = data.paging?.next || null;
        }
      } catch (e) {
        console.warn(`fetchFacebookAlbumPhotos: album ${albumId} error:`, e.message);
      }
    }));
  }

  console.log(`fetchFacebookAlbumPhotos: found ${allPhotos.length} unique album photos`);
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
    existingCallback.reuses = (existingCallback.reuses || 0) + 1;
    // After too many duplicates, stop processing entirely
    if (existingCallback.reuses > MAX_CODE_REUSES) {
      return res.status(200).send(
        '<html><body style="background:#111;color:#fff;font-family:sans-serif;text-align:center;padding:60px;">' +
        '<h2>Already authenticated!</h2><p>Return to <a href="' + frontendUrl + '" style="color:#ff2d55;">Heartbreak Sweep</a>.</p>' +
        '<script>setTimeout(function(){window.location="' + frontendUrl + '"},2000)</script></body></html>'
      );
    }
    // If we already have the redirect URL cached, use it instantly
    if (existingCallback.redirectUrl) {
      return res.redirect(existingCallback.redirectUrl);
    }
    // Otherwise wait for the original promise (only for first few duplicates)
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

    const redirectUrl = buildFrontendRedirect(frontendUrl, {
      user: user.id,
      userId: user.id,
      id: user.id,
      token: accessToken,
      access_token: accessToken,
      fbToken: accessToken,
    });

    // Cache for recovery from duplicate/expired code scenarios
    lastSuccessfulRedirectUrl = redirectUrl;
    tokenCache.set(accessToken, { timestamp: Date.now(), redirectUrl });
    // Prune old token cache entries
    for (const [tk, entry] of tokenCache.entries()) {
      if (Date.now() - entry.timestamp > TOKEN_CACHE_TTL_MS) tokenCache.delete(tk);
    }

    console.log(`OAuth success for user ${user.id} (${user.name})`);
    return redirectUrl;
  })();

  oauthCallbacks.set(code, {
    timestamp: Date.now(),
    promise: callbackPromise,
    redirectUrl: null,
    reuses: 0,
  });

  try {
    const redirectUrl = await callbackPromise;
    // Cache the resolved URL so future duplicates resolve instantly
    const entry = oauthCallbacks.get(code);
    if (entry) entry.redirectUrl = redirectUrl;
    res.redirect(redirectUrl);
  } catch (err) {
    const oauthError = err.response?.data || { message: err.message };
    console.error('OAuth error:', JSON.stringify(oauthError));

    // If the code was already used (loop case), try to recover
    const fbError = oauthError?.error || oauthError;
    const fbCode = fbError?.code;
    const fbSubcode = fbError?.error_subcode;

    // Code already used OR code expired — try to recover with cached redirect
    if ((fbCode === 100 && fbSubcode === 36009) || (fbCode === 100 && fbSubcode === 36007) || /already been used|expired/i.test(fbError?.message || '')) {
      console.log('Code reuse/expiry detected. Attempting recovery...');

      // Check if we already completed this code
      const cachedEntry = oauthCallbacks.get(code);
      if (cachedEntry?.redirectUrl) {
        console.log('Recovered from cached code entry');
        return res.redirect(cachedEntry.redirectUrl);
      }

      // Fall back to last successful redirect (likely same user retrying after CAPTCHA)
      if (lastSuccessfulRedirectUrl) {
        console.log('Recovered using last successful redirect');
        return res.redirect(lastSuccessfulRedirectUrl);
      }

      // No recovery possible
      return res.redirect(
        buildFrontendRedirect(frontendUrl, {
          auth_error: 'code_used',
          message: 'Facebook login code expired during CAPTCHA. Please try again — the server is now warm and it will be faster.',
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
  const { token, refPhoto, refPhotos, offset, limit, targetName } = req.body;

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
      const rawBuf = Buffer.from(base64Data, 'base64');

      // Convert to JPEG to guarantee Rekognition compatibility (WebP, BMP, GIF not supported)
      let buf;
      try {
        buf = await sharp(rawBuf).jpeg({ quality: 95 }).toBuffer();
      } catch (sharpErr) {
        return res.status(400).json({
          error: `Reference photo #${i + 1} is not a valid image: ${sharpErr.message}`,
        });
      }

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

    const allPhotosRaw = Array.from(
      new Map([...uploadedPhotos, ...taggedPhotos].map((photo) => [photo.id, photo])).values()
    );

    const totalPhotos = allPhotosRaw.length;
    const uploadedCount = uploadedPhotos.length;
    const taggedCount = taggedPhotos.length;

    // Free the full photo arrays early to save memory
    uploadedPhotos = null;
    taggedPhotos = null;

    if (!totalPhotos) {
      return res.json({
        matches: [],
        message:
          'Facebook returned 0 accessible photos. This usually means the account has no uploaded/tagged photos available to this app yet, or the app lacks access for this Facebook user.',
        diagnostics: {
          refPhotosUsed: refBuffers.length,
          uploadedPhotos: 0,
          taggedPhotos: 0,
          scannedPhotos: 0,
          totalPhotos: 0,
        },
      });
    }

    // Strip each photo to only the fields we need — saves memory on large accounts
    const allPhotos = allPhotosRaw.map(p => ({
      id: p.id,
      _type: p._type,
      created_time: p.created_time,
      bestImageSource: p.images?.[0]?.source || null,
      tags: p.tags,
    }));
    // Free the raw array now that we've extracted what we need
    allPhotosRaw.length = 0;

    // Apply offset/limit for resume-scan support
    const startOffset = Math.max(0, Math.min(Number(offset) || 0, totalPhotos));
    const scanLimit = (Number(limit) > 0) ? Number(limit) : totalPhotos;
    const photos = allPhotos.slice(startOffset, startOffset + scanLimit);
    console.log(`Scanning photos ${startOffset} to ${startOffset + photos.length} of ${totalPhotos} total`);

    const matches = [];
    let awsAuthError = null;
    let comparedPhotos = 0;
    let skippedPhotos = 0;
    let rekognitionErrors = 0;
    let compareErrors = 0;
    let noFaceInTarget = 0;
    let tagMatches = 0;

    // Normalize target name for tag matching
    const normalizedTargetName = (targetName || '').trim().toLowerCase();

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

    // 3. Smart screening: use FIRST ref photo to screen, then verify hits with remaining refs
    const PROCESSING_TIME_LIMIT_MS = 4 * 60 * 1000; // 4 minutes (Render allows 5 min max)
    const BATCH_SIZE = 10; // Higher batch = more parallel Rekognition calls
    const processingStartTime = Date.now();
    let timedOut = false;
    let firstInvalidParamLogged = false;
    let permissionError = null;
    const primaryRef = refBuffers[0];
    const secondaryRefs = refBuffers.slice(1);

    const processPhoto = async (photo) => {
      if (awsAuthError || permissionError) return;

      const imageUrl = photo.bestImageSource;
      if (!imageUrl) {
        skippedPhotos += 1;
        return;
      }

      // Helper: check tags for name match
      const checkTagMatch = () => {
        if (!normalizedTargetName) return false;
        const tags = photo.tags?.data || [];
        return tags.some(t => (t.name || '').toLowerCase().includes(normalizedTargetName));
      };

      try {
        const imgRes = await axios.get(imageUrl, {
          responseType: 'arraybuffer',
          timeout: 15000,
          headers: { Accept: 'image/jpeg, image/png, image/*' },
        });

        // Convert to JPEG to ensure Rekognition compatibility (Facebook CDN may serve WebP)
        // Resize to max 1024px to save memory — Rekognition doesn't need full-res
        let imgBuffer;
        try {
          imgBuffer = await sharp(imgRes.data)
            .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
            .jpeg({ quality: 80 })
            .toBuffer();
        } catch (convertErr) {
          console.warn(`Skipping photo ${photo.id}: image conversion failed: ${convertErr.message}`);
          skippedPhotos += 1;
          if (checkTagMatch()) {
            tagMatches += 1;
            matches.push({ id: photo.id, url: imageUrl, confidence: 0, date: photo.created_time || null, owned: photo._type === 'uploaded', matchType: 'tag' });
          }
          return;
        }

        if (imgBuffer.length > 5 * 1024 * 1024) {
          console.warn(`Skipping photo ${photo.id}: ${(imgBuffer.length / 1024 / 1024).toFixed(1)} MB exceeds 5 MB limit`);
          skippedPhotos += 1;
          if (checkTagMatch()) {
            tagMatches += 1;
            matches.push({ id: photo.id, url: imageUrl, confidence: 0, date: photo.created_time || null, owned: photo._type === 'uploaded', matchType: 'tag' });
          }
          return;
        }

        comparedPhotos += 1;
        let bestSimilarity = 0;

        // Screen with primary ref first
        try {
          const rekRes = await rekognition
            .compareFaces({
              SourceImage: { Bytes: primaryRef },
              TargetImage: { Bytes: imgBuffer },
              SimilarityThreshold: 60,
            })
            .promise();

          // Check ALL face matches — group photos may have multiple faces
          for (const fm of (rekRes.FaceMatches || [])) {
            if (fm.Similarity > bestSimilarity) {
              bestSimilarity = fm.Similarity;
            }
          }
        } catch (cmpErr) {
          if (!firstInvalidParamLogged && cmpErr.code === 'InvalidParameterException') {
            console.error(`FIRST InvalidParameterException — photo ${photo.id}, targetSize=${imgBuffer.length}, refSize=${primaryRef.length}, msg: ${cmpErr.message}`);
            firstInvalidParamLogged = true;
          }
          compareErrors += 1;
          if (cmpErr.code === 'InvalidParameterException' && /no face/i.test(cmpErr.message)) {
            noFaceInTarget += 1;
          }
          if (isAwsAuthError(cmpErr)) { awsAuthError = cmpErr; return; }
          if (isAwsPermissionError(cmpErr)) { permissionError = cmpErr; return; }
        }

        // Only verify with secondary refs if primary got a hit
        if (bestSimilarity > 0 && secondaryRefs.length > 0) {
          for (const refBuf of secondaryRefs) {
            if (awsAuthError || permissionError) break;
            try {
              const rekRes = await rekognition
                .compareFaces({
                  SourceImage: { Bytes: refBuf },
                  TargetImage: { Bytes: imgBuffer },
                  SimilarityThreshold: 60,
                })
                .promise();

              for (const fm of (rekRes.FaceMatches || [])) {
                if (fm.Similarity > bestSimilarity) {
                  bestSimilarity = fm.Similarity;
                }
              }
            } catch (cmpErr) {
              compareErrors += 1;
              if (isAwsAuthError(cmpErr)) { awsAuthError = cmpErr; break; }
              if (isAwsPermissionError(cmpErr)) { permissionError = cmpErr; break; }
            }
          }
        }

        if (bestSimilarity > 0) {
          // Determine ownership
          const isOwned = photo._type === 'uploaded';
          matches.push({
            id: photo.id,
            url: imageUrl,
            confidence: Math.round(bestSimilarity),
            date: photo.created_time || null,
            owned: isOwned,
            matchType: 'face',
          });
        } else if (checkTagMatch()) {
          // Check tags for name match if face recognition didn't hit
          const isOwned = photo._type === 'uploaded';
          tagMatches += 1;
          matches.push({
            id: photo.id,
            url: imageUrl,
            confidence: 0,
            date: photo.created_time || null,
            owned: isOwned,
            matchType: 'tag',
          });
        }
      } catch (err) {
        console.error(`Error processing photo ${photo.id}: [${err.code || ''}] ${err.message}`);
        rekognitionErrors += 1;
        if (isAwsAuthError(err)) {
          awsAuthError = err;
        }
      }
    };

    for (let i = 0; i < photos.length; i += BATCH_SIZE) {
      if (awsAuthError || permissionError) break;
      if (Date.now() - processingStartTime > PROCESSING_TIME_LIMIT_MS) {
        timedOut = true;
        console.warn(`Processing time limit reached after ${comparedPhotos}/${photos.length} photos (offset ${startOffset})`);
        break;
      }
      const batch = photos.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(processPhoto));
    }

    if (permissionError) {
      return res.status(500).json({
        error: 'AWS Rekognition permission denied',
        details: permissionError.message,
        fix: 'Attach an IAM policy allowing rekognition:CompareFaces on *.',
      });
    }

    if (awsAuthError) {
      return res.status(500).json({
        error: 'AWS Rekognition authentication failed',
        details: awsAuthError.message,
        fix: 'Update AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, and AWS_REGION in Render.',
      });
    }

    matches.sort((left, right) => (right.confidence || 0) - (left.confidence || 0));

    const scannedUpTo = startOffset + comparedPhotos + skippedPhotos;
    let message = `Scanned ${comparedPhotos} Facebook photos (range ${startOffset + 1}–${scannedUpTo} of ${totalPhotos}) using ${refBuffers.length} reference photo(s).`;
    if (timedOut) {
      message += ' (Processing time limit reached — partial results returned.)';
    }
    if (matches.length) {
      message += ` Found ${matches.length} match(es).`;
    } else {
      if ((rekognitionErrors + compareErrors) > 0 && (rekognitionErrors + compareErrors) >= comparedPhotos) {
        message = `Tried to scan ${comparedPhotos} photos but comparisons failed (${compareErrors} compare errors, ${noFaceInTarget} no-face-in-target). Try different reference photos.`;
      } else if (comparedPhotos > 0) {
        message = `Scanned ${comparedPhotos} photos with ${refBuffers.length} reference(s) but found no face matches above 20% (${compareErrors} compare errors, ${noFaceInTarget} no-face-in-target). Try clearer front-facing reference photos.`;
      } else {
        message = 'Facebook photos were found, but none could be processed.';
      }
    }

    res.json({
      matches,
      message,
      diagnostics: {
        refPhotosUsed: refBuffers.length,
        uploadedPhotos: uploadedCount,
        taggedPhotos: taggedCount,
        totalPhotos,
        scannedRange: [startOffset, scannedUpTo],
        comparedPhotos,
        skippedPhotos,
        rekognitionErrors,
        compareErrors,
        noFaceInTarget,
        tagMatches,
        timedOut,
      },
    });
  } catch (err) {
    console.error('Analyze error:', err.message);
    res.status(500).json({ error: 'Analysis failed', details: err.message });
  }
});

// � Background scan: Start a scan job that runs without timeout
app.post('/scan/start', async (req, res) => {
  const { token, refPhotos: rawRefPhotos, refPhoto, targetName } = req.body;

  const rawPhotos = Array.isArray(rawRefPhotos) && rawRefPhotos.length > 0
    ? rawRefPhotos
    : refPhoto ? [refPhoto] : [];

  if (!token || !rawPhotos.length) {
    return res.status(400).json({ error: 'Missing token or reference photo(s)' });
  }

  // Validate ref photos upfront before returning jobId
  const refBuffers = [];
  for (let i = 0; i < rawPhotos.length; i++) {
    const base64Data = rawPhotos[i].split(',')[1];
    if (!base64Data) {
      return res.status(400).json({ error: `Reference photo #${i + 1} has an invalid format.` });
    }
    const rawBuf = Buffer.from(base64Data, 'base64');
    let buf;
    try {
      buf = await sharp(rawBuf).jpeg({ quality: 95 }).toBuffer();
    } catch (sharpErr) {
      return res.status(400).json({ error: `Reference photo #${i + 1} is not a valid image: ${sharpErr.message}` });
    }
    if (buf.length > 5 * 1024 * 1024) {
      return res.status(400).json({ error: `Reference photo #${i + 1} is too large. Max 5 MB.` });
    }
    try {
      const detectRes = await rekognition.detectFaces({ Image: { Bytes: buf }, Attributes: ['DEFAULT'] }).promise();
      if ((detectRes.FaceDetails || []).length === 0) {
        return res.status(400).json({ error: `No face detected in reference photo #${i + 1}. Upload a clear, front-facing photo.` });
      }
    } catch (detectErr) {
      return res.status(500).json({ error: `Could not validate reference photo #${i + 1}.`, details: detectErr.message });
    }
    refBuffers.push(buf);
  }

  pruneJobs();
  const jobId = generateJobId();
  const job = {
    createdAt: Date.now(),
    status: 'running',
    phase: 'fetching',
    totalPhotos: 0,
    scannedPhotos: 0,
    matchCount: 0,
    matches: [],
    message: 'Fetching photos from Facebook...',
    error: null,
    diagnostics: null,
  };
  scanJobs.set(jobId, job);

  // Return immediately — scan runs in background
  res.json({ jobId });

  // --- Background processing ---
  (async () => {
    try {
      let uploadedPhotos = [];
      let taggedPhotos = [];
      let albumPhotos = [];
      try {
        [uploadedPhotos, taggedPhotos, albumPhotos] = await Promise.all([
          fetchFacebookPhotoSet(token, 'uploaded'),
          fetchFacebookPhotoSet(token, 'tagged'),
          fetchFacebookAlbumPhotos(token),
        ]);
      } catch (fbErr) {
        job.status = 'error';
        job.error = 'Facebook API error: ' + (fbErr.details?.message || fbErr.message);
        return;
      }

      const allPhotosRaw = Array.from(
        new Map([...uploadedPhotos, ...taggedPhotos, ...albumPhotos].map(p => [p.id, p])).values()
      );
      const uploadedCount = uploadedPhotos.length;
      const taggedCount = taggedPhotos.length;
      const albumCount = albumPhotos.length;
      uploadedPhotos = null;
      taggedPhotos = null;
      albumPhotos = null;

      if (!allPhotosRaw.length) {
        job.status = 'done';
        job.message = 'Facebook returned 0 accessible photos.';
        job.diagnostics = { refPhotosUsed: refBuffers.length, uploadedPhotos: 0, taggedPhotos: 0, totalPhotos: 0, scannedPhotos: 0 };
        return;
      }

      const allPhotos = allPhotosRaw.map(p => ({
        id: p.id,
        _type: p._type,
        created_time: p.created_time,
        bestImageSource: p.images?.[0]?.source || null,
        tags: p.tags,
      }));
      allPhotosRaw.length = 0;

      job.totalPhotos = allPhotos.length;
      job.phase = 'scanning';
      job.message = `Scanning ${allPhotos.length} photos...`;

      const normalizedTargetName = (targetName || '').trim().toLowerCase();
      const BATCH_SIZE = 10;
      const primaryRef = refBuffers[0];
      const secondaryRefs = refBuffers.slice(1);
      let comparedPhotos = 0;
      let skippedPhotos = 0;
      let compareErrors = 0;
      let noFaceInTarget = 0;
      let tagMatches = 0;
      let awsAuthError = null;
      let permissionError = null;

      const isAwsAuthError = (err) => {
        const msg = String(err?.message || '').toLowerCase();
        const code = String(err?.code || '').toLowerCase();
        return msg.includes('security token included in the request is invalid') || code === 'unrecognizedclientexception' || code === 'invalidsignatureexception';
      };

      const isAwsPermissionError = (err) => {
        const code = String(err?.code || '').toLowerCase();
        const msg = String(err?.message || '').toLowerCase();
        return code === 'accessdeniedexception' || msg.includes('is not authorized to perform');
      };

      const processPhoto = async (photo) => {
        if (awsAuthError || permissionError) return;
        const imageUrl = photo.bestImageSource;
        if (!imageUrl) { skippedPhotos++; return; }

        const checkTagMatch = () => {
          if (!normalizedTargetName) return false;
          return (photo.tags?.data || []).some(t => (t.name || '').toLowerCase().includes(normalizedTargetName));
        };

        try {
          const imgRes = await axios.get(imageUrl, {
            responseType: 'arraybuffer',
            timeout: 15000,
            headers: { Accept: 'image/jpeg, image/png, image/*' },
          });

          let imgBuffer;
          try {
            imgBuffer = await sharp(imgRes.data)
              .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 })
              .toBuffer();
          } catch (convertErr) {
            skippedPhotos++;
            if (checkTagMatch()) {
              tagMatches++;
              job.matches.push({ id: photo.id, url: imageUrl, confidence: 0, date: photo.created_time || null, owned: photo._type === 'uploaded', matchType: 'tag' });
              job.matchCount = job.matches.length;
            }
            return;
          }

          if (imgBuffer.length > 5 * 1024 * 1024) {
            skippedPhotos++;
            if (checkTagMatch()) {
              tagMatches++;
              job.matches.push({ id: photo.id, url: imageUrl, confidence: 0, date: photo.created_time || null, owned: photo._type === 'uploaded', matchType: 'tag' });
              job.matchCount = job.matches.length;
            }
            return;
          }

          comparedPhotos++;
          let bestSimilarity = 0;

          // Screen with primary ref first — only call secondary refs if primary gets a hit
          try {
            const primaryRes = await rekognition.compareFaces({
              SourceImage: { Bytes: primaryRef },
              TargetImage: { Bytes: imgBuffer },
              SimilarityThreshold: 60,
            }).promise();
            for (const fm of (primaryRes.FaceMatches || [])) {
              if (fm.Similarity > bestSimilarity) bestSimilarity = fm.Similarity;
            }
          } catch (cmpErr) {
            compareErrors++;
            if (cmpErr.code === 'InvalidParameterException' && /no face/i.test(cmpErr.message)) noFaceInTarget++;
            if (isAwsAuthError(cmpErr)) { awsAuthError = cmpErr; return; }
            if (isAwsPermissionError(cmpErr)) { permissionError = cmpErr; return; }
          }

          // Only verify with secondary refs if primary got a hit
          if (bestSimilarity > 0 && secondaryRefs.length > 0) {
            for (const refBuf of secondaryRefs) {
              if (awsAuthError || permissionError) break;
              try {
                const rekRes = await rekognition.compareFaces({
                  SourceImage: { Bytes: refBuf },
                  TargetImage: { Bytes: imgBuffer },
                  SimilarityThreshold: 60,
                }).promise();
                for (const fm of (rekRes.FaceMatches || [])) {
                  if (fm.Similarity > bestSimilarity) bestSimilarity = fm.Similarity;
                }
              } catch (cmpErr) {
                compareErrors++;
                if (isAwsAuthError(cmpErr)) { awsAuthError = cmpErr; return; }
                if (isAwsPermissionError(cmpErr)) { permissionError = cmpErr; return; }
              }
            }
          }

          if (bestSimilarity > 0) {
            job.matches.push({
              id: photo.id, url: imageUrl, confidence: Math.round(bestSimilarity),
              date: photo.created_time || null, owned: photo._type === 'uploaded', matchType: 'face',
            });
          } else if (checkTagMatch()) {
            tagMatches++;
            job.matches.push({
              id: photo.id, url: imageUrl, confidence: 0,
              date: photo.created_time || null, owned: photo._type === 'uploaded', matchType: 'tag',
            });
          }
          job.matchCount = job.matches.length;
        } catch (err) {
          skippedPhotos++;
          if (isAwsAuthError(err)) awsAuthError = err;
        }
      };

      for (let i = 0; i < allPhotos.length; i += BATCH_SIZE) {
        if (awsAuthError || permissionError) break;
        const batch = allPhotos.slice(i, i + BATCH_SIZE);
        await Promise.all(batch.map(processPhoto));
        job.scannedPhotos = comparedPhotos + skippedPhotos;
        job.message = `Scanned ${job.scannedPhotos} of ${job.totalPhotos} photos (${job.matchCount} matches so far)...`;
      }

      if (awsAuthError) {
        job.status = 'error';
        job.error = 'AWS Rekognition authentication failed. Check AWS credentials in Render.';
        return;
      }
      if (permissionError) {
        job.status = 'error';
        job.error = 'AWS Rekognition permission denied. Attach rekognition:CompareFaces policy.';
        return;
      }

      job.matches.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      job.status = 'done';
      job.scannedPhotos = comparedPhotos + skippedPhotos;
      job.message = `Scanned all ${job.totalPhotos} photos using ${refBuffers.length} reference(s). Found ${job.matches.length} match(es).`;
      job.diagnostics = {
        refPhotosUsed: refBuffers.length,
        uploadedPhotos: uploadedCount,
        taggedPhotos: taggedCount,
        albumPhotos: albumCount,
        totalPhotos: job.totalPhotos,
        scannedPhotos: comparedPhotos,
        skippedPhotos,
        compareErrors,
        noFaceInTarget,
        tagMatches,
      };
      console.log(`Job ${jobId} complete: ${job.matches.length} matches in ${job.totalPhotos} photos`);
    } catch (err) {
      console.error(`Job ${jobId} fatal error:`, err.message);
      job.status = 'error';
      job.error = err.message;
    }
  })();
});

// 🚀 Background scan: Poll for job status
app.get('/scan/status/:jobId', (req, res) => {
  const job = scanJobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: 'Job not found. It may have expired.' });
  }
  res.json({
    status: job.status,
    phase: job.phase,
    totalPhotos: job.totalPhotos,
    scannedPhotos: job.scannedPhotos,
    matchCount: job.matchCount,
    matches: job.matches,
    message: job.message,
    error: job.error,
    diagnostics: job.diagnostics,
  });
});

// �🔥 Delete endpoint: deletes OWN photos or untags from others' photos
app.post('/delete', async (req, res) => {
  const { token, ids, userId } = req.body;

  if (!token || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'Missing token or ids in body' });
  }

  // Get current user ID if not provided
  let currentUserId = userId;
  if (!currentUserId) {
    try {
      const meRes = await axios.get('https://graph.facebook.com/me', {
        params: { access_token: token, fields: 'id' },
      });
      currentUserId = meRes.data.id;
    } catch (e) {
      console.error('Could not fetch user ID for untag:', e.message);
    }
  }

  try {
    const results = [];

    for (const item of ids) {
      const photoId = typeof item === 'object' ? item.id : item;
      const isOwned = typeof item === 'object' ? item.owned : true;

      try {
        if (isOwned) {
          // Delete own photo
          const delRes = await axios.delete(
            `https://graph.facebook.com/v18.0/${encodeURIComponent(photoId)}`,
            { params: { access_token: token } }
          );
          results.push({ id: photoId, success: true, action: 'deleted', response: delRes.data });
        } else if (currentUserId) {
          // Untag self from others' photo
          const untagRes = await axios.delete(
            `https://graph.facebook.com/v18.0/${encodeURIComponent(photoId)}/tags`,
            { params: { access_token: token, tag_uid: currentUserId } }
          );
          results.push({ id: photoId, success: true, action: 'untagged', response: untagRes.data });
        } else {
          results.push({ id: photoId, success: false, error: 'Could not determine user ID for untagging' });
        }
      } catch (err) {
        console.error(`Delete/untag error for ${photoId}:`, err.response?.data || err.message);
        // If delete fails, try untag as fallback
        if (isOwned && currentUserId) {
          try {
            const untagRes = await axios.delete(
              `https://graph.facebook.com/v18.0/${encodeURIComponent(photoId)}/tags`,
              { params: { access_token: token, tag_uid: currentUserId } }
            );
            results.push({ id: photoId, success: true, action: 'untagged (delete failed)', response: untagRes.data });
            continue;
          } catch (untagErr) {
            console.error(`Untag fallback failed for ${photoId}:`, untagErr.response?.data || untagErr.message);
          }
        }
        results.push({
          id: photoId,
          success: false,
          error: err.response?.data || err.message,
        });
      }
    }

    // Summarize errors for the client
    const succeeded = results.filter(r => r.success);
    const failed = results.filter(r => !r.success);
    const errorReasons = [...new Set(failed.map(r => {
      const fbErr = r.error?.error || r.error;
      return fbErr?.message || fbErr?.type || JSON.stringify(r.error || 'Unknown');
    }).filter(Boolean))];

    res.json({ deleted: results, summary: { succeeded: succeeded.length, failed: failed.length, errorReasons } });
  } catch (err) {
    console.error('Delete endpoint error:', err.message);
    res.status(500).json({ error: 'Delete failed', details: err.message });
  }
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'Heartbreak Sweep API Running',
    endpoints: ['/auth/callback', '/auth/google/callback', '/photos', '/analyze', '/scan/start', '/scan/status/:jobId', '/scan/device', '/scan/google/start', '/delete'],
  });
});

// ─── Device Photo Scan ────────────────────────────────────────────────────
// Accepts an array of base64 target photos from the browser, compares each
// against the reference photo(s) using Rekognition, returns matched indices.
app.post('/scan/device', async (req, res) => {
  const { refPhotos: rawRefPhotos, refPhoto, targetPhotos } = req.body;

  const rawRefs = Array.isArray(rawRefPhotos) && rawRefPhotos.length > 0
    ? rawRefPhotos : refPhoto ? [refPhoto] : [];

  if (!rawRefs.length) return res.status(400).json({ error: 'Missing reference photo(s).' });
  if (!Array.isArray(targetPhotos) || !targetPhotos.length) return res.status(400).json({ error: 'Missing targetPhotos array.' });

  // Build ref buffers
  const refBuffers = [];
  for (let i = 0; i < rawRefs.length; i++) {
    const base64Data = rawRefs[i].split(',')[1];
    if (!base64Data) return res.status(400).json({ error: `Reference photo #${i + 1} has invalid format.` });
    let buf;
    try { buf = await sharp(Buffer.from(base64Data, 'base64')).jpeg({ quality: 95 }).toBuffer(); }
    catch (e) { return res.status(400).json({ error: `Reference photo #${i + 1} is not a valid image.` }); }
    refBuffers.push(buf);
  }

  const primaryRef = refBuffers[0];
  const secondaryRefs = refBuffers.slice(1);
  const matches = [];

  const isAwsAuthError = (err) => {
    const msg = String(err?.message || '').toLowerCase();
    return msg.includes('security token included in the request is invalid') || String(err?.code || '') === 'UnrecognizedClientException';
  };

  for (let idx = 0; idx < targetPhotos.length; idx++) {
    const base64Data = targetPhotos[idx]?.split(',')[1];
    if (!base64Data) continue;
    let imgBuffer;
    try {
      imgBuffer = await sharp(Buffer.from(base64Data, 'base64'))
        .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 82 }).toBuffer();
    } catch (e) { continue; }
    if (imgBuffer.length > 5 * 1024 * 1024) continue;

    let bestSimilarity = 0;
    try {
      const res = await rekognition.compareFaces({
        SourceImage: { Bytes: primaryRef },
        TargetImage: { Bytes: imgBuffer },
        SimilarityThreshold: 60,
      }).promise();
      for (const fm of (res.FaceMatches || [])) if (fm.Similarity > bestSimilarity) bestSimilarity = fm.Similarity;
    } catch (cmpErr) {
      if (isAwsAuthError(cmpErr)) return res.status(500).json({ error: 'AWS authentication failed.' });
      continue;
    }

    if (bestSimilarity > 0 && secondaryRefs.length > 0) {
      for (const refBuf of secondaryRefs) {
        try {
          const res = await rekognition.compareFaces({
            SourceImage: { Bytes: refBuf },
            TargetImage: { Bytes: imgBuffer },
            SimilarityThreshold: 60,
          }).promise();
          for (const fm of (res.FaceMatches || [])) if (fm.Similarity > bestSimilarity) bestSimilarity = fm.Similarity;
        } catch (e) {}
      }
    }

    if (bestSimilarity > 0) matches.push({ index: idx, confidence: Math.round(bestSimilarity) });
  }

  matches.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  res.json({ matches, total: targetPhotos.length });
});

// ─── Google Photos OAuth & Scan ───────────────────────────────────────────

// Google OAuth redirect helper
app.get('/auth/google', (req, res) => {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`;
  const frontendUrl = process.env.FRONTEND_UNIVERSAL_URL || process.env.FRONTEND_URL || 'https://heartbreaksweeper.com';

  if (!clientId) {
    return res.redirect(`${frontendUrl}?authError=google_not_configured&message=Google+OAuth+not+set+up+on+server`);
  }

  const scope = encodeURIComponent('https://www.googleapis.com/auth/photoslibrary.readonly');
  const state = encodeURIComponent(req.query.state || '');
  const url = `https://accounts.google.com/o/oauth2/v2/auth?client_id=${encodeURIComponent(clientId)}&redirect_uri=${encodeURIComponent(redirectUri)}&response_type=code&scope=${scope}&access_type=offline&prompt=consent&state=${state}`;
  res.redirect(url);
});

// Google OAuth callback
app.get('/auth/google/callback', async (req, res) => {
  const { code, error: oauthError } = req.query;
  const frontendUrl = process.env.FRONTEND_UNIVERSAL_URL || process.env.FRONTEND_URL || 'https://heartbreaksweeper.com';
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || `${req.protocol}://${req.get('host')}/auth/google/callback`;

  if (oauthError) {
    return res.redirect(`${frontendUrl}?authError=google_denied&message=${encodeURIComponent('Google access denied.')}`);
  }
  if (!code) {
    return res.redirect(`${frontendUrl}?authError=google_no_code`);
  }

  try {
    const tokenRes = await axios.post('https://oauth2.googleapis.com/token', null, {
      params: {
        code,
        client_id: process.env.GOOGLE_CLIENT_ID,
        client_secret: process.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: 'authorization_code',
      },
    });

    const { access_token: accessToken } = tokenRes.data;
    if (!accessToken) throw new Error('No access_token in Google token response');

    // Redirect back to the universal frontend with the Google token
    const redirectTarget = new URL(frontendUrl);
    redirectTarget.searchParams.set('googleToken', accessToken);
    redirectTarget.searchParams.set('platform', 'google');
    res.redirect(redirectTarget.toString());
  } catch (err) {
    console.error('Google OAuth error:', err.response?.data || err.message);
    res.redirect(`${frontendUrl}?authError=google_token_failed&message=${encodeURIComponent('Google authentication failed. Try again.')}`);
  }
});

// Fetch all Google Photos media items (photos only, paged)
async function fetchGooglePhotos(accessToken) {
  const allPhotos = [];
  let pageToken = null;

  do {
    const body = { pageSize: 100, filters: { mediaTypeFilter: { mediaTypes: ['PHOTO'] } } };
    if (pageToken) body.pageToken = pageToken;

    const res = await axios.post(
      'https://photoslibrary.googleapis.com/v1/mediaItems:search',
      body,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );

    const items = res.data.mediaItems || [];
    items.forEach(item => {
      allPhotos.push({
        id: item.id,
        // Append =d to get the original download URL
        bestImageSource: item.baseUrl + '=d',
        created_time: item.mediaMetadata?.creationTime || null,
        _type: 'uploaded',
        tags: null,
      });
    });
    pageToken = res.data.nextPageToken || null;
  } while (pageToken);

  console.log(`fetchGooglePhotos: found ${allPhotos.length} photos`);
  return allPhotos;
}

// Background scan for Google Photos — same pattern as /scan/start
app.post('/scan/google/start', async (req, res) => {
  const { googleToken, refPhotos: rawRefPhotos, refPhoto } = req.body;

  const rawPhotos = Array.isArray(rawRefPhotos) && rawRefPhotos.length > 0
    ? rawRefPhotos : refPhoto ? [refPhoto] : [];

  if (!googleToken || !rawPhotos.length) {
    return res.status(400).json({ error: 'Missing googleToken or reference photo(s)' });
  }

  // Validate ref photos
  const refBuffers = [];
  for (let i = 0; i < rawPhotos.length; i++) {
    const base64Data = rawPhotos[i].split(',')[1];
    if (!base64Data) return res.status(400).json({ error: `Reference photo #${i + 1} has an invalid format.` });
    const rawBuf = Buffer.from(base64Data, 'base64');
    let buf;
    try { buf = await sharp(rawBuf).jpeg({ quality: 95 }).toBuffer(); }
    catch (e) { return res.status(400).json({ error: `Reference photo #${i + 1} is not a valid image.` }); }
    if (buf.length > 5 * 1024 * 1024) return res.status(400).json({ error: `Reference photo #${i + 1} is too large. Max 5 MB.` });
    try {
      const detectRes = await rekognition.detectFaces({ Image: { Bytes: buf }, Attributes: ['DEFAULT'] }).promise();
      if ((detectRes.FaceDetails || []).length === 0)
        return res.status(400).json({ error: `No face detected in reference photo #${i + 1}. Upload a clear, front-facing photo.` });
    } catch (detectErr) {
      return res.status(500).json({ error: `Could not validate reference photo #${i + 1}.`, details: detectErr.message });
    }
    refBuffers.push(buf);
  }

  pruneJobs();
  const jobId = generateJobId();
  const job = {
    createdAt: Date.now(), status: 'running', phase: 'fetching',
    totalPhotos: 0, scannedPhotos: 0, matchCount: 0, matches: [],
    message: 'Fetching photos from Google Photos...', error: null, diagnostics: null,
  };
  scanJobs.set(jobId, job);
  res.json({ jobId });

  // Background processing
  (async () => {
    try {
      let allPhotos;
      try {
        allPhotos = await fetchGooglePhotos(googleToken);
      } catch (err) {
        job.status = 'error';
        job.error = 'Google Photos API error: ' + (err.response?.data?.error?.message || err.message);
        return;
      }

      if (!allPhotos.length) {
        job.status = 'done';
        job.message = 'Google Photos returned 0 accessible photos.';
        job.diagnostics = { refPhotosUsed: refBuffers.length, totalPhotos: 0, scannedPhotos: 0 };
        return;
      }

      job.totalPhotos = allPhotos.length;
      job.phase = 'scanning';
      job.message = `Scanning ${allPhotos.length} Google Photos...`;

      const primaryRef = refBuffers[0];
      const secondaryRefs = refBuffers.slice(1);
      const BATCH_SIZE = 10;
      let comparedPhotos = 0, skippedPhotos = 0, compareErrors = 0, noFaceInTarget = 0;
      let awsAuthError = null, permissionError = null;

      const isAwsAuthError = (err) => {
        const msg = String(err?.message || '').toLowerCase();
        const code = String(err?.code || '').toLowerCase();
        return msg.includes('security token included in the request is invalid') || code === 'unrecognizedclientexception';
      };
      const isAwsPermissionError = (err) => {
        const code = String(err?.code || '').toLowerCase();
        return code === 'accessdeniedexception' || String(err?.message || '').toLowerCase().includes('is not authorized');
      };

      const processPhoto = async (photo) => {
        if (awsAuthError || permissionError) return;
        if (!photo.bestImageSource) { skippedPhotos++; return; }
        try {
          const imgRes = await axios.get(photo.bestImageSource, {
            responseType: 'arraybuffer', timeout: 15000, headers: { Accept: 'image/*' },
          });
          let imgBuffer;
          try {
            imgBuffer = await sharp(imgRes.data)
              .resize({ width: 1024, height: 1024, fit: 'inside', withoutEnlargement: true })
              .jpeg({ quality: 82 }).toBuffer();
          } catch (e) { skippedPhotos++; return; }

          if (imgBuffer.length > 5 * 1024 * 1024) { skippedPhotos++; return; }

          comparedPhotos++;
          let bestSimilarity = 0;

          try {
            const res = await rekognition.compareFaces({
              SourceImage: { Bytes: primaryRef },
              TargetImage: { Bytes: imgBuffer },
              SimilarityThreshold: 60,
            }).promise();
            for (const fm of (res.FaceMatches || [])) {
              if (fm.Similarity > bestSimilarity) bestSimilarity = fm.Similarity;
            }
          } catch (cmpErr) {
            compareErrors++;
            if (cmpErr.code === 'InvalidParameterException' && /no face/i.test(cmpErr.message)) noFaceInTarget++;
            if (isAwsAuthError(cmpErr)) { awsAuthError = cmpErr; return; }
            if (isAwsPermissionError(cmpErr)) { permissionError = cmpErr; return; }
          }

          if (bestSimilarity > 0 && secondaryRefs.length > 0) {
            for (const refBuf of secondaryRefs) {
              if (awsAuthError || permissionError) break;
              try {
                const res = await rekognition.compareFaces({
                  SourceImage: { Bytes: refBuf },
                  TargetImage: { Bytes: imgBuffer },
                  SimilarityThreshold: 60,
                }).promise();
                for (const fm of (res.FaceMatches || [])) {
                  if (fm.Similarity > bestSimilarity) bestSimilarity = fm.Similarity;
                }
              } catch (cmpErr) {
                compareErrors++;
                if (isAwsAuthError(cmpErr)) { awsAuthError = cmpErr; return; }
                if (isAwsPermissionError(cmpErr)) { permissionError = cmpErr; return; }
              }
            }
          }

          if (bestSimilarity > 0) {
            job.matches.push({ id: photo.id, url: photo.bestImageSource, confidence: Math.round(bestSimilarity), date: photo.created_time, owned: true, matchType: 'face' });
            job.matchCount = job.matches.length;
          }
        } catch (err) {
          skippedPhotos++;
          if (isAwsAuthError(err)) awsAuthError = err;
        }
      };

      for (let i = 0; i < allPhotos.length; i += BATCH_SIZE) {
        if (awsAuthError || permissionError) break;
        await Promise.all(allPhotos.slice(i, i + BATCH_SIZE).map(processPhoto));
        job.scannedPhotos = comparedPhotos + skippedPhotos;
        job.message = `Scanned ${job.scannedPhotos} of ${job.totalPhotos} Google Photos (${job.matchCount} matches so far)...`;
      }

      if (awsAuthError) { job.status = 'error'; job.error = 'AWS authentication failed.'; return; }
      if (permissionError) { job.status = 'error'; job.error = 'AWS permission denied.'; return; }

      job.matches.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      job.status = 'done';
      job.scannedPhotos = comparedPhotos + skippedPhotos;
      job.message = `Scanned all ${job.totalPhotos} Google Photos using ${refBuffers.length} reference(s). Found ${job.matches.length} match(es).`;
      job.diagnostics = { refPhotosUsed: refBuffers.length, totalPhotos: job.totalPhotos, scannedPhotos: comparedPhotos, skippedPhotos, compareErrors, noFaceInTarget };
      console.log(`Google scan job ${jobId} complete: ${job.matches.length} matches in ${job.totalPhotos} photos`);
    } catch (err) {
      console.error(`Google scan job ${jobId} fatal error:`, err.message);
      job.status = 'error';
      job.error = err.message;
    }
  })();
});

// ─── Stripe Payment Endpoints ─────────────────────────────────────────────

// In-memory payment records (keyed by Facebook access token / sessionId)
// In production you'd use a database, but this works for MVP.
const paidSessions = new Map(); // sessionId -> { paid: true, timestamp, stripeSessionId }
const PAID_SESSION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

function prunePayments() {
  const now = Date.now();
  for (const [key, val] of paidSessions.entries()) {
    if (now - val.timestamp > PAID_SESSION_TTL_MS) paidSessions.delete(key);
  }
}
setInterval(prunePayments, 10 * 60 * 1000);

// Create a Stripe Checkout Session
app.post('/create-checkout-session', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured on server.' });
  }

  const { sessionId: userSession, returnUrl } = req.body;
  if (!userSession) {
    return res.status(400).json({ error: 'Missing sessionId.' });
  }

  // Already paid?
  if (paidSessions.has(userSession)) {
    return res.json({ alreadyPaid: true });
  }

  try {
    const checkoutSession = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'usd',
          product_data: {
            name: 'Heartbreak Sweeper — Photo Cleanup',
            description: 'Unlock deletion & download for your matched photos (up to 1,500 photos)',
          },
          unit_amount: 499, // $4.99 in cents
        },
        quantity: 1,
      }],
      mode: 'payment',
      success_url: `${returnUrl || 'https://heartbreaksweeper.com'}?payment=success&sid=${encodeURIComponent(userSession)}`,
      cancel_url: `${returnUrl || 'https://heartbreaksweeper.com'}?payment=cancelled`,
      metadata: {
        userSession,
      },
    });

    res.json({ url: checkoutSession.url, sessionId: checkoutSession.id });
  } catch (err) {
    console.error('Stripe checkout error:', err.message);
    res.status(500).json({ error: 'Failed to create checkout session.' });
  }
});

// Verify payment status
app.post('/verify-payment', async (req, res) => {
  const { sessionId: userSession } = req.body;
  if (!userSession) {
    return res.status(400).json({ error: 'Missing sessionId.' });
  }

  if (paidSessions.has(userSession)) {
    return res.json({ paid: true });
  }

  return res.json({ paid: false });
});

// Record payment (called by frontend after successful Stripe redirect)
app.post('/record-payment', async (req, res) => {
  if (!stripe) {
    return res.status(500).json({ error: 'Stripe not configured.' });
  }

  const { sessionId: userSession, stripeSessionId } = req.body;
  if (!userSession || !stripeSessionId) {
    return res.status(400).json({ error: 'Missing sessionId or stripeSessionId.' });
  }

  try {
    // Verify with Stripe that the payment actually happened
    const checkoutSession = await stripe.checkout.sessions.retrieve(stripeSessionId);

    if (checkoutSession.payment_status === 'paid') {
      paidSessions.set(userSession, {
        paid: true,
        timestamp: Date.now(),
        stripeSessionId,
      });
      return res.json({ paid: true });
    } else {
      return res.json({ paid: false, reason: 'Payment not completed.' });
    }
  } catch (err) {
    console.error('Stripe verify error:', err.message);
    return res.status(500).json({ error: 'Failed to verify payment.' });
  }
});

// ─── Startup Warnings ────────────────────────────────────────────────────

// Stripe env var check
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('Warning: Missing STRIPE_SECRET_KEY. Payment endpoints will not work.');
}

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

