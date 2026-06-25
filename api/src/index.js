require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Redis = require('ioredis');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || 'default-secret-key';
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const BUILDS_DIR = process.env.BUILDS_DIR || path.join(DATA_DIR, 'builds');
const UPLOADS_DIR = path.join(DATA_DIR, 'uploads');

// Ensure directories exist
fs.mkdirSync(UPLOADS_DIR, { recursive: true });
fs.mkdirSync(BUILDS_DIR, { recursive: true });

// Initialize Redis
const redis = new Redis(process.env.REDIS_URL || 'redis://127.0.0.1:6379');
redis.on('error', (err) => console.error('Redis connection error:', err));
redis.on('connect', () => console.log('✔ Connected to Redis'));

// Multer Storage Configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, UPLOADS_DIR);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + '-' + uniqueSuffix + '.zip');
  }
});
const upload = multer({ 
  storage,
  limits: { fileSize: 100 * 1024 * 1024 } // 100MB limit
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Auth Middleware
const authenticate = (req, res, next) => {
  const authHeader = req.headers['x-api-key'];
  const queryKey = req.query.apiKey;
  const apiKey = authHeader || queryKey;

  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized. Invalid or missing X-API-Key header.' });
  }
  next();
};

// Route: Health Check
app.get('/', (req, res) => {
  res.json({ status: 'online', service: 'mybuild-api', version: '1.0.0' });
});

// Route: Auth Login Check
app.post('/auth/login', (req, res) => {
  const { apiKey } = req.body;
  if (!apiKey || apiKey !== API_KEY) {
    return res.status(401).json({ error: 'Invalid API Key' });
  }
  res.json({ success: true, message: 'Authenticated successfully' });
});

// Route: Submit Build Request
app.post('/build', authenticate, upload.single('file'), async (req, res) => {
  try {
    const { projectName = 'MobileApp', platform = 'android', buildType } = req.body;
    if (!req.file) {
      return res.status(400).json({ error: 'No project archive (.zip) file provided.' });
    }

    if (platform !== 'android') {
      return res.status(400).json({ error: 'Only android platform is currently supported.' });
    }

    const buildId = 'build-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
    const zipPath = req.file.path;

    // Create record in DB
    const build = db.createBuild({
      id: buildId,
      projectName,
      platform,
      status: 'queued',
      buildType
    });

    // Create build folder for logs/output later
    const buildFolder = path.join(BUILDS_DIR, buildId);
    fs.mkdirSync(buildFolder, { recursive: true });

    // Initialize an empty log file
    const logFile = path.join(buildFolder, 'logs.txt');
    fs.writeFileSync(logFile, `[SYSTEM] Build queued at ${new Date().toISOString()}\n`, 'utf8');

    db.updateBuild(buildId, {
      logsPath: logFile
    });

    // Enqueue job details to Redis queue
    const jobPayload = {
      id: buildId,
      zipPath,
      platform,
      projectName,
      logFile,
      buildType
    };

    await redis.rpush('mybuild_queue', JSON.stringify(jobPayload));
    console.log(`Enqueued build job ${buildId}`);

    res.json({
      success: true,
      message: 'Build successfully enqueued',
      buildId,
      status: 'queued'
    });
  } catch (error) {
    console.error('Error initiating build:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Route: Get All Builds
app.get('/builds', authenticate, (req, res) => {
  try {
    const rawBuilds = db.getBuilds();
    const builds = rawBuilds.map(b => {
      // Create a shallow copy to prevent mutating local DB in-memory cache directly
      const bCopy = { ...b };
      if (bCopy.status === 'completed') {
        const protocol = req.secure ? 'https' : 'http';
        bCopy.downloadUrl = `${protocol}://${req.headers.host}/builds/download/${bCopy.id}`;
      }
      return bCopy;
    });
    res.json(builds);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve builds' });
  }
});

// Route: Get Single Build Status
app.get('/build/:id', authenticate, (req, res) => {
  try {
    const build = db.getBuild(req.params.id);
    if (!build) {
      return res.status(404).json({ error: 'Build job not found.' });
    }
    
    // Create copy for dynamic response decoration
    const buildCopy = { ...build };
    if (buildCopy.status === 'completed') {
      const protocol = req.secure ? 'https' : 'http';
      buildCopy.downloadUrl = `${protocol}://${req.headers.host}/builds/download/${buildCopy.id}`;
    }
    
    res.json(buildCopy);
  } catch (error) {
    res.status(500).json({ error: 'Failed to retrieve build details' });
  }
});

// Route: Get Build Logs
app.get('/build/:id/logs', authenticate, (req, res) => {
  try {
    const build = db.getBuild(req.params.id);
    if (!build) {
      return res.status(404).json({ error: 'Build job not found.' });
    }

    const logFile = build.logsPath;
    if (!logFile || !fs.existsSync(logFile)) {
      return res.send('Build logs not initialized yet.');
    }

    // Set text headers and stream file or read directly
    res.setHeader('Content-Type', 'text/plain');
    const stream = fs.createReadStream(logFile);
    stream.pipe(res);
  } catch (error) {
    res.status(500).send('Failed to read logs: ' + error.message);
  }
});

// Route: Download Output APK/AAB
app.get('/builds/download/:id', (req, res) => {
  try {
    // This download route doesn't strictly need auth if we want APK download links to be easily shareable/accessible.
    // However, let's verify if an api key query param is needed. Let's make it public for ease of downloading on phones,
    // or authenticate it. Let's check query key if it's there, but to allow direct downloads we can make it public or support query key auth.
    // Let's support both: public download or query apiKey token if provided. Let's make it public for simple link sharing.
    const build = db.getBuild(req.params.id);
    if (!build) {
      return res.status(404).json({ error: 'Build job not found.' });
    }

    if (build.status !== 'completed') {
      return res.status(400).json({ error: `Build is not completed yet. Current status: ${build.status}` });
    }

    const buildFolder = path.join(BUILDS_DIR, req.params.id);
    // Find any APK or AAB file in the builds folder
    const files = fs.readdirSync(buildFolder);
    const buildFile = files.find(file => file.endsWith('.apk') || file.endsWith('.aab'));

    if (!buildFile) {
      return res.status(404).json({ error: 'Build output artifact not found.' });
    }

    const filePath = path.join(buildFolder, buildFile);
    res.download(filePath, buildFile, (err) => {
      if (err) {
        console.error('Download error:', err);
      }
    });
  } catch (error) {
    console.error('Download error:', error);
    res.status(500).json({ error: 'Failed to initiate download' });
  }
});

// Route: Update Build Status
app.patch('/build/:id', authenticate, (req, res) => {
  try {
    const { status, downloadUrl, error, buildType } = req.body;
    const build = db.getBuild(req.params.id);
    if (!build) {
      return res.status(404).json({ error: 'Build job not found.' });
    }

    const updates = {};
    if (status) updates.status = status;
    if (downloadUrl) updates.downloadUrl = downloadUrl;
    if (error) updates.error = error;
    if (buildType) updates.buildType = buildType;

    const updatedBuild = db.updateBuild(req.params.id, updates);
    res.json(updatedBuild);
  } catch (error) {
    console.error('Error updating build:', error);
    res.status(500).json({ error: 'Failed to update build status' });
  }
});

// Route: Cancel Build Job
app.post('/build/:id/cancel', authenticate, async (req, res) => {
  try {
    const build = db.getBuild(req.params.id);
    if (!build) {
      return res.status(404).json({ error: 'Build job not found.' });
    }

    if (build.status === 'completed' || build.status === 'failed' || build.status === 'cancelled') {
      return res.status(400).json({ error: `Cannot cancel a build that is already ${build.status}.` });
    }

    // Update status in DB
    db.updateBuild(req.params.id, { status: 'cancelled' });

    // Append to logs that cancellation was requested
    if (build.logsPath && fs.existsSync(build.logsPath)) {
      fs.appendFileSync(build.logsPath, `\n[SYSTEM] Build cancellation requested by user.\n`, 'utf8');
    }

    // Publish cancellation message to Redis PubSub
    await redis.publish('mybuild_cancellation', req.params.id);

    console.log(`Cancellation requested for build ${req.params.id}`);
    res.json({ success: true, message: 'Cancellation request sent successfully' });
  } catch (error) {
    console.error('Error cancelling build:', error);
    res.status(500).json({ error: 'Failed to process build cancellation' });
  }
});

// Start Server
app.listen(PORT, () => {
  console.log(`========================================`);
  console.log(`✔ mybuild API Server running on port ${PORT}`);
  console.log(`✔ Data directory is set to ${DATA_DIR}`);
  console.log(`========================================`);
});
