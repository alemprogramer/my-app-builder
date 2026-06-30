require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const Redis = require('ioredis');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const AdmZip = require('adm-zip');

const API_URL = process.env.API_URL || 'http://127.0.0.1:3000';
const API_KEY = process.env.API_KEY || 'default-secret-key';
const REDIS_URL = process.env.REDIS_URL || 'redis://127.0.0.1:6379';
const WORKER_DIR = process.env.WORKER_DIR || '/tmp/mybuild-worker';

// Ensure working temp directory and sandboxed HOME exist
fs.mkdirSync(WORKER_DIR, { recursive: true });
fs.mkdirSync('/tmp/mybuild-home', { recursive: true });

// Track active build state for cancellation
let activeBuildId = null;
let activeChildProcess = null;

// Initialize Redis
const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('Redis worker connection error:', err));
redis.on('connect', () => console.log('✔ Worker connected to Redis'));

// Initialize Redis for PubSub (disable ready check to avoid subscriber commands error)
const subRedis = new Redis(REDIS_URL, { enableReadyCheck: false });
subRedis.on('error', (err) => console.error('Redis PubSub error:', err));
subRedis.on('connect', () => {
  console.log('✔ Worker PubSub connected');
  subRedis.subscribe('mybuild_cancellation');
});

subRedis.on('message', (channel, message) => {
  if (channel === 'mybuild_cancellation' && message === activeBuildId) {
    console.log(`[CANCELLATION] Cancelling active build job: ${activeBuildId}`);
    if (activeChildProcess) {
      console.log(`[CANCELLATION] Terminating active compiler process...`);
      try {
        activeChildProcess.kill('SIGKILL');
      } catch (err) {
        console.error(`[CANCELLATION] Failed to terminate child process: ${err.message}`);
      }
    }
  }
});

// Helper to run commands and pipe output to log file
function runCommand(cmd, args, cwd, writeStream) {
  return new Promise((resolve, reject) => {
    writeStream.write(`\n[SYSTEM] Executing: ${cmd} ${args.join(' ')}\n`);
    console.log(`[SYSTEM] Executing in ${cwd}: ${cmd} ${args.join(' ')}`);

    const child = spawn(cmd, args, {
      cwd,
      shell: true,
      env: {
        ...process.env,
        // Bypass global npm cache permission restrictions
        npm_config_cache: process.env.npm_config_cache || '/tmp/npm-cache',
        // Redirect HOME to prevent Expo/Gradle config permissions issues
        HOME: '/tmp/mybuild-home',
        // Ensure standard paths and android SDK configuration are passed
        ANDROID_HOME: process.env.ANDROID_HOME || '/opt/android-sdk',
        JAVA_HOME: process.env.JAVA_HOME
      }
    });

    activeChildProcess = child;

    child.stdout.on('data', (data) => {
      writeStream.write(data);
    });

    child.stderr.on('data', (data) => {
      writeStream.write(data);
    });

    child.on('close', (code) => {
      activeChildProcess = null;
      if (code === 0) {
        writeStream.write(`[SYSTEM] Success: ${cmd} completed successfully.\n`);
        resolve();
      } else {
        writeStream.write(`[SYSTEM] Failure: ${cmd} failed with exit code ${code}.\n`);
        reject(new Error(`Command failed with exit code ${code}`));
      }
    });

    child.on('error', (err) => {
      writeStream.write(`[SYSTEM] Error starting command ${cmd}: ${err.message}\n`);
      reject(err);
    });
  });
}

// Update status to API
async function updateStatus(buildId, status, extra = {}) {
  try {
    await axios.patch(`${API_URL}/build/${buildId}`, {
      status,
      ...extra
    }, {
      headers: {
        'x-api-key': API_KEY
      }
    });
  } catch (error) {
    console.error(`Failed to update status for ${buildId}:`, error.message);
  }
}

// Core Build Execution Loop
async function processQueue() {
  console.log('Worker listening for build jobs...');
  while (true) {
    let jobData;
    try {
      // Blocking pop from the queue (blocks indefinitely until item arrives)
      const job = await redis.blpop('mybuild_queue', 0);
      if (!job) continue;

      jobData = JSON.parse(job[1]);
      console.log(`\n========================================`);
      console.log(`Processing build job ${jobData.id} for ${jobData.projectName}`);
      console.log(`========================================`);
    } catch (err) {
      console.error('Error popping job from Redis:', err);
      // Brief sleep before retrying to prevent CPU thrashing
      await new Promise(resolve => setTimeout(resolve, 5000));
      continue;
    }

    const { id, zipPath, platform, projectName, logFile } = jobData;
    activeBuildId = id;
    const buildTempDir = path.join(WORKER_DIR, id);
    let logStream;

    try {
      // 1. Set status to building
      await updateStatus(id, 'building');

      logStream = fs.createWriteStream(logFile, { flags: 'a' });
      logStream.write(`[SYSTEM] Starting build worker task for project: ${projectName}\n`);

      // 2. Extract zip file
      logStream.write(`[SYSTEM] Extracting project archive...\n`);
      fs.mkdirSync(buildTempDir, { recursive: true });
      const zip = new AdmZip(zipPath);
      zip.extractAllTo(buildTempDir, true);
      logStream.write(`[SYSTEM] Extraction completed.\n`);

      // 3. Install dependencies
      logStream.write(`[SYSTEM] Installing dependencies...\n`);
      const hasYarn = fs.existsSync(path.join(buildTempDir, 'yarn.lock'));
      const hasBun = fs.existsSync(path.join(buildTempDir, 'bun.lockb'));

      let installCmd = 'npm';
      let installArgs = ['install'];
      if (hasYarn) {
        installCmd = 'yarn';
        installArgs = ['install'];
      } else if (hasBun) {
        installCmd = 'bun';
        installArgs = ['install'];
      }

      await runCommand(installCmd, installArgs, buildTempDir, logStream);

      // 4. Run Expo prebuild
      logStream.write(`[SYSTEM] Running npx expo prebuild...\n`);
      await runCommand('npx', ['expo', 'prebuild', '--platform', 'android', '--no-install'], buildTempDir, logStream);

      // 5. Build Android Release (APK/AAB)
      const androidDir = path.join(buildTempDir, 'android');
      if (!fs.existsSync(androidDir)) {
        throw new Error('Android directory not found after running expo prebuild');
      }

      // Ensure gradlew is executable
      logStream.write(`[SYSTEM] Giving execute permissions to gradlew...\n`);
      await runCommand('chmod', ['+x', 'gradlew'], androidDir, logStream);

      // Check build type (explicitly passed or dynamically detected)
      let buildType = jobData.buildType;

      if (!buildType) {
        buildType = 'release';
        try {
          const packageJsonPath = path.join(buildTempDir, 'package.json');
          if (fs.existsSync(packageJsonPath)) {
            const pkgJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
            if (pkgJson.dependencies && pkgJson.dependencies['expo-dev-client']) {
              buildType = 'debug';
            }
          }
        } catch (e) {
          logStream.write(`[SYSTEM] Warning: Failed to parse package.json for build type detection: ${e.message}\n`);
        }
      }

      // Update API database with the selected/detected build type
      await updateStatus(id, 'building', { buildType });

      let gradleTask;
      let buildSubDir;
      let outputFileName;
      let fileExtension;

      if (buildType === 'debug') {
        gradleTask = 'assembleDebug';
        buildSubDir = path.join('apk', 'debug');
        outputFileName = 'app-debug.apk';
        fileExtension = 'apk';
      } else if (buildType === 'aab') {
        gradleTask = 'bundleRelease';
        buildSubDir = path.join('bundle', 'release');
        outputFileName = 'app-release.aab';
        fileExtension = 'aab';
      } else {
        // default release APK
        gradleTask = 'assembleRelease';
        buildSubDir = path.join('apk', 'release');
        outputFileName = 'app-release.apk';
        fileExtension = 'apk';
      }

      logStream.write(`[SYSTEM] Running gradle ${gradleTask} (Build Type: ${buildType})...\n`);
      await runCommand('./gradlew', [gradleTask], androidDir, logStream);

      // Find output artifact
      const outputDir = path.join(androidDir, 'app', 'build', 'outputs', buildSubDir);
      const artifactPath = path.join(outputDir, outputFileName);

      if (!fs.existsSync(artifactPath)) {
        throw new Error(`Build artifact not found in expected output directory: ${artifactPath}`);
      }

      // 6. Copy output back to shared public folder
      const finalBuildFolder = path.dirname(logFile); // Same as logsPath folder
      const finalArtifactPath = path.join(finalBuildFolder, `${projectName}-${buildType}.${fileExtension}`);
      fs.copyFileSync(artifactPath, finalArtifactPath);

      logStream.write(`[SYSTEM] Build succeeded! Saving artifact: ${projectName}-${buildType}.${fileExtension}\n`);
      console.log(`Build ${id} succeeded!`);

      // 7. Update status to completed
      await updateStatus(id, 'completed', {
        downloadUrl: `${API_URL}/builds/download/${id}`
      });

    } catch (error) {
      console.error(`Build ${id} failed:`, error.message);
      if (logStream) {
        logStream.write(`\n[SYSTEM] BUILD FAILED: ${error.message}\n`);
      }

      // Check if it was cancelled
      let isCancelled = false;
      try {
        const buildInfoRes = await axios.get(`${API_URL}/build/${id}`, {
          headers: { 'x-api-key': API_KEY }
        });
        if (buildInfoRes.data && buildInfoRes.data.status === 'cancelled') {
          isCancelled = true;
        }
      } catch (e) {
        // ignore
      }

      if (isCancelled) {
        if (logStream) {
          logStream.write(`[SYSTEM] Build aborted by user cancellation.\n`);
        }
        await updateStatus(id, 'cancelled');
      } else {
        await updateStatus(id, 'failed', {
          error: error.message
        });
      }
    } finally {
      // Close file stream
      if (logStream) {
        logStream.end();
      }

      // Cleanup files to prevent storage filling up
      try {
        if (fs.existsSync(buildTempDir)) {
          console.log(`Cleaning up build directory ${buildTempDir}`);
          fs.rmSync(buildTempDir, { recursive: true, force: true });
        }
        if (fs.existsSync(zipPath)) {
          console.log(`Cleaning up uploaded ZIP file ${zipPath}`);
          fs.unlinkSync(zipPath);
        }
      } catch (cleanupErr) {
        console.error('Error during cleanup:', cleanupErr.message);
      }

      activeBuildId = null;
      activeChildProcess = null;
    }
  }
}

// Start polling
processQueue();
