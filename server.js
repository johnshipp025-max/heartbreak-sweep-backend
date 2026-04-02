// server.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const AWS = require('aws-sdk');
const sharp = require('sharp');

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
const oauthCallbacks = new Map(); // code -> { timestamp, promise, redirectUrl, reuses }
const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_CODE_REUSES = 3;

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
    const BATCH_SIZE = 3; // Keep low to avoid memory spikes on Render free tier (512 MB)
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
              SimilarityThreshold: 20,
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
                  SimilarityThreshold: 20,
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

// 🔥 Delete endpoint: deletes OWN photos or untags from others' photos
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

