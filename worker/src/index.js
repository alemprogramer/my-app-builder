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

// Initialize Redis
const redis = new Redis(REDIS_URL);
redis.on('error', (err) => console.error('Redis worker connection error:', err));
redis.on('connect', () => console.log('✔ Worker connected to Redis'));

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

    child.stdout.on('data', (data) => {
      writeStream.write(data);
    });

    child.stderr.on('data', (data) => {
      writeStream.write(data);
    });

    child.on('close', (code) => {
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

      logStream.write(`[SYSTEM] Running gradle assembleRelease...\n`);
      await runCommand('./gradlew', ['assembleRelease'], androidDir, logStream);

      // Find output APK
      const apkOutDir = path.join(androidDir, 'app', 'build', 'outputs', 'apk', 'release');
      const apkPath = path.join(apkOutDir, 'app-release.apk');

      if (!fs.existsSync(apkPath)) {
        throw new Error('APK not found in expected output directory: ' + apkPath);
      }

      // 6. Copy output back to shared public folder
      const finalBuildFolder = path.dirname(logFile); // Same as logsPath folder
      const finalApkPath = path.join(finalBuildFolder, `${projectName}-release.apk`);
      fs.copyFileSync(apkPath, finalApkPath);

      logStream.write(`[SYSTEM] Build succeeded! Saving artifact.\n`);
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
      await updateStatus(id, 'failed', {
        error: error.message
      });
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
    }
  }
}

// Start polling
processQueue();
