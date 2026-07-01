const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const axios = require('axios');
const FormData = require('form-data');
const archiver = require('archiver');
const QRCode = require('qrcode');

const CONFIG_DIR = path.join(os.homedir(), '.mybuild');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const program = new Command();
program
  .name('mybuild')
  .description('CLI tool for self-hosted React Native & Expo mobile app builds')
  .version('1.0.0');

// Helper to ask user for input
function askQuestion(query) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });
  return new Promise(resolve => rl.question(query, ans => {
    rl.close();
    resolve(ans.trim());
  }));
}

// Helper to choose build type using Arrow Keys (TTY) or simple prompt (non-TTY)
async function chooseBuildType() {
  const question = 'Select build type:';
  const options = [
    'Release APK (Production - for direct installation / sharing)',
    'Release AAB (Production - for Google Play Store upload)',
    'Debug APK (Development - for expo-dev-client / testing)'
  ];

  if (!process.stdin.isTTY) {
    console.log(question);
    options.forEach((opt, idx) => console.log(`  ${idx + 1}) ${opt}`));
    const choice = await askQuestion('Enter choice (1, 2 or 3, default: 1): ');
    if (choice === '2') return 'aab';
    if (choice === '3') return 'debug';
    return 'release';
  }

  return new Promise((resolve) => {
    let cursor = 0;
    
    // Hide standard cursor
    process.stdout.write('\u001B[?25l');
    
    const render = () => {
      readline.cursorTo(process.stdout, 0);
      readline.clearScreenDown(process.stdout);
      
      process.stdout.write(`\u001b[33m?\u001b[39m \u001b[1m${question}\u001b[22m\n`);
      options.forEach((opt, idx) => {
        if (idx === cursor) {
          process.stdout.write(`\u001b[36m❯ ${opt}\u001b[39m\n`);
        } else {
          process.stdout.write(`  ${opt}\n`);
        }
      });
      
      readline.moveCursor(process.stdout, 0, -(options.length + 1));
    };

    render();

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    
    const onKeypress = (str, key) => {
      if (key.ctrl && key.name === 'c') {
        process.stdout.write('\u001B[?25h');
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.exit(130);
      }
      
      if (key.name === 'up') {
        cursor = (cursor - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        cursor = (cursor + 1) % options.length;
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        process.stdin.removeListener('keypress', onKeypress);
        process.stdin.setRawMode(false);
        process.stdin.pause();
        
        readline.moveCursor(process.stdout, 0, options.length + 1);
        process.stdout.write('\u001B[?25h');
        
        console.log(`✔ Selected: \u001b[36m${options[cursor]}\u001b[39m\n`);
        
        let result = 'release';
        if (cursor === 1) {
          result = 'aab';
        } else if (cursor === 2) {
          result = 'debug';
        }
        resolve(result);
      }
    };
    
    process.stdin.on('keypress', onKeypress);
  });
}

// Helper to print scannable QR Code
function printQRCode(url) {
  return new Promise((resolve) => {
    QRCode.toString(url, { type: 'terminal', small: true }, function (err, str) {
      if (!err) {
        console.log(str);
      } else {
        console.error('Failed to generate QR Code:', err.message);
      }
      resolve();
    });
  });
}

// Config management helpers
function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) {
    return null;
  }
  try {
    const raw = fs.readFileSync(CONFIG_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (err) {
    return null;
  }
}

function saveConfig(config) {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true });
  }
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf8');
}

// Verify CLI state
function getClient() {
  const config = loadConfig();
  if (!config || !config.apiUrl || !config.apiKey) {
    console.error('Error: CLI not configured. Run "mybuild init" first.');
    process.exit(1);
  }
  
  return axios.create({
    baseURL: config.apiUrl,
    headers: { 'x-api-key': config.apiKey },
    timeout: 120000 // 120 seconds timeout to survive heavy CPU bundling loads
  });
}

// Command: Init Configuration
program
  .command('init')
  .argument('[url]', 'VPS API Server URL')
  .argument('[key]', 'VPS API Access Key')
  .description('Initialize or update connection settings to your build VPS')
  .action(async (url, key) => {
    let finalUrl = url;
    let finalKey = key;

    if (!finalUrl) {
      finalUrl = await askQuestion('Enter your VPS API Server URL (e.g., http://123.45.67.89:3000): ');
    }
    if (!finalKey) {
      finalKey = await askQuestion('Enter your API Key: ');
    }

    if (!finalUrl || !finalKey) {
      console.error('Error: Both Server URL and API Key are required.');
      return;
    }

    // Clean up trailing slash from URL
    if (finalUrl.endsWith('/')) {
      finalUrl = finalUrl.slice(0, -1);
    }

    // Validate connection
    console.log(`Connecting to ${finalUrl}/auth/login...`);
    try {
      await axios.post(`${finalUrl}/auth/login`, { apiKey: finalKey });
      saveConfig({ apiUrl: finalUrl, apiKey: finalKey });
      console.log('✔ Configuration successful! Settings saved in ~/.mybuild/config.json');
    } catch (err) {
      console.error('✖ Connection failed. Please check your URL and Key:');
      if (err.response) {
        console.error(`  Server returned status ${err.response.status}:`, err.response.data.error || err.response.statusText);
      } else {
        console.error(`  Error message: ${err.message}`);
      }
    }
  });

// Command: Login
program
  .command('login')
  .argument('[key]', 'VPS API Access Key')
  .description('Update or verify authentication with the server')
  .action(async (key) => {
    const config = loadConfig();
    if (!config || !config.apiUrl) {
      console.error('Error: Please run "mybuild init" first to specify the server URL.');
      return;
    }

    let finalKey = key;
    if (!finalKey) {
      finalKey = await askQuestion('Enter your API Key: ');
    }

    if (!finalKey) {
      console.error('Error: API Key is required.');
      return;
    }

    try {
      await axios.post(`${config.apiUrl}/auth/login`, { apiKey: finalKey });
      config.apiKey = finalKey;
      saveConfig(config);
      console.log('✔ Authenticated successfully. API key updated.');
    } catch (err) {
      console.error('✖ Login failed. Invalid API key.');
    }
  });

// Helper: Zip directory
function zipDirectory(sourceDir, outPath) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });

    output.on('close', () => resolve());
    archive.on('error', err => reject(err));

    archive.pipe(output);

    const ignores = [
      'node_modules',
      '.git',
      '.expo',
      'android',
      'ios',
      'web-build',
      'dist',
      '.mybuild',
      'mybuild-temp.zip'
    ];

    archive.directory(sourceDir, false, (entry) => {
      const relativePath = entry.name;
      const shouldIgnore = ignores.some(ignored => {
        return relativePath === ignored || relativePath.startsWith(ignored + '/');
      });
      return shouldIgnore ? false : entry;
    });

    archive.finalize();
  });
}

// Helper: Shared build executor
async function startBuildSession(currentDir, buildType) {
  const appJsonPath = path.join(currentDir, 'app.json');
  const packageJsonPath = path.join(currentDir, 'package.json');

  if (!fs.existsSync(appJsonPath) && !fs.existsSync(packageJsonPath)) {
    throw new Error('This command must be run inside a valid Expo project folder (containing app.json or package.json).');
  }

  // Read app/project name
  let projectName = 'MobileApp';
  try {
    if (fs.existsSync(appJsonPath)) {
      const appJson = JSON.parse(fs.readFileSync(appJsonPath, 'utf8'));
      if (appJson.expo && appJson.expo.name) {
        projectName = appJson.expo.name.replace(/[^a-zA-Z0-9]/g, '');
      }
    } else if (fs.existsSync(packageJsonPath)) {
      const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
      if (packageJson.name) {
        projectName = packageJson.name.replace(/[^a-zA-Z0-9]/g, '');
      }
    }
  } catch (e) {
    // Fallback to MobileApp
  }

  const client = getClient();
  const tempZipPath = path.join(CONFIG_DIR, `mybuild-temp-${Date.now()}.zip`);

  try {
    console.log('📦 Archiving local project directory (excluding node_modules/build artifacts)...');
    await zipDirectory(currentDir, tempZipPath);
    console.log(`✔ Archive created successfully (${(fs.statSync(tempZipPath).size / (1024 * 1024)).toFixed(2)} MB).`);

    console.log('🚀 Uploading project package to build server...');
    const form = new FormData();
    form.append('projectName', projectName);
    form.append('platform', 'android');
    if (buildType) {
      form.append('buildType', buildType);
    }
    form.append('file', fs.createReadStream(tempZipPath));

    const uploadRes = await client.post('/build', form, {
      headers: form.getHeaders(),
      maxContentLength: Infinity,
      maxBodyLength: Infinity
    });

    const { buildId } = uploadRes.data;
    return buildId;
  } finally {
    // Clean up local temp zip
    if (fs.existsSync(tempZipPath)) {
      fs.unlinkSync(tempZipPath);
    }
  }
}

// Command: Build Android
program
  .command('build')
  .argument('<platform>', 'target build platform (currently only "android")')
  .option('-t, --type <type>', 'build type: release, debug or aab')
  .description('Build project release package on your self-hosted VPS')
  .action(async (platform, options) => {
    if (platform !== 'android') {
      console.error('Error: Only "android" target platform is currently supported.');
      return;
    }

    let buildType = options.type;
    if (buildType) {
      buildType = buildType.toLowerCase();
      if (buildType !== 'release' && buildType !== 'debug' && buildType !== 'aab') {
        console.error('Error: Build type must be "release", "debug", or "aab".');
        return;
      }
    } else {
      buildType = await chooseBuildType();
    }

    try {
      const currentDir = process.cwd();
      const buildId = await startBuildSession(currentDir, buildType);
      console.log(`✔ Project uploaded. Assigned Build ID: ${buildId}`);
      console.log(`Streaming build logs...\n`);

      const client = getClient();
      let printedLines = 0;
      let isFinished = false;

      while (!isFinished) {
        await new Promise(resolve => setTimeout(resolve, 2500));

        let logs = '';
        try {
          const logRes = await client.get(`/build/${buildId}/logs`);
          logs = logRes.data;
        } catch (err) {}

        const logLines = logs.split('\n');
        if (logLines.length > printedLines) {
          const newLines = logLines.slice(printedLines, logLines.length - 1);
          newLines.forEach(line => console.log(line));
          printedLines = logLines.length - 1;
        }

        let buildInfo;
        try {
          const statusRes = await client.get(`/build/${buildId}`);
          buildInfo = statusRes.data;
        } catch (err) {
          // Ignore transient API server errors/hang-ups under heavy load and retry
          continue;
        }

        if (buildInfo.status === 'completed') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`✔ BUILD SUCCESSFUL`);
          console.log(`========================================`);
          const isAab = buildInfo.buildType === 'aab' || buildInfo.downloadUrl.endsWith('.aab');
          console.log(`Download ${isAab ? 'AAB' : 'APK'}: ${buildInfo.downloadUrl}`);
          if (!isAab) {
            console.log(`\nScan the QR code below to download direct to your device:`);
            await printQRCode(buildInfo.downloadUrl);
          }
          console.log(`========================================\n`);
        } else if (buildInfo.status === 'failed') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`✖ BUILD FAILED`);
          console.log(`========================================`);
          console.log(`Reason: ${buildInfo.error || 'Unknown error'}`);
          console.log(`========================================\n`);
        } else if (buildInfo.status === 'cancelled') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`⚠ BUILD CANCELLED BY USER`);
          console.log(`========================================\n`);
        }
      }
    } catch (error) {
      console.error('✖ Build failed:', error.message);
    }
  });

// Command: Get Build Status
program
  .command('status')
  .argument('[id]', 'Build ID to query')
  .description('Retrieve history or detailed status of a specific build')
  .action(async (id) => {
    const client = getClient();
    try {
      if (id) {
        const res = await client.get(`/build/${id}`);
        const build = res.data;
        console.log(`Build ID:   ${build.id}`);
        console.log(`Project:    ${build.projectName}`);
        console.log(`Platform:   ${build.platform}`);
        if (build.buildType) console.log(`Build Type: ${build.buildType.toUpperCase()}`);
        console.log(`Status:     ${build.status.toUpperCase()}`);
        console.log(`Created:    ${new Date(build.createdAt).toLocaleString()}`);
        if (build.downloadUrl) console.log(`Artifact:   ${build.downloadUrl}`);
        if (build.error) console.log(`Error:      ${build.error}`);
      } else {
        const res = await client.get('/builds');
        const builds = res.data;
        if (builds.length === 0) {
          console.log('No builds found on this server.');
          return;
        }
        console.log(String('ID').padEnd(30) + String('PROJECT').padEnd(20) + String('TYPE').padEnd(10) + String('STATUS').padEnd(12) + String('CREATED'));
        console.log(''.padEnd(90, '-'));
        builds.slice(0, 10).forEach(b => {
          console.log(
            String(b.id).padEnd(30) + 
            String(b.projectName).padEnd(20) + 
            String(b.buildType || 'N/A').padEnd(10) + 
            String(b.status.toUpperCase()).padEnd(12) + 
            new Date(b.createdAt).toLocaleString()
          );
        });
        if (builds.length > 10) {
          console.log(`... and ${builds.length - 10} more. Run "mybuild status <id>" for details.`);
        }
      }
    } catch (err) {
      console.error('✖ Failed to fetch status:', err.message);
    }
  });

// Command: View Build Logs
program
  .command('logs')
  .argument('<id>', 'Build ID to fetch logs for')
  .option('-w, --watch', 'Stream build logs live in real-time')
  .description('Fetch and display build logs from the server')
  .action(async (id, options) => {
    const client = getClient();
    
    if (!options.watch) {
      try {
        const res = await client.get(`/build/${id}/logs`);
        console.log(res.data);
      } catch (err) {
        console.error('✖ Failed to fetch logs:', err.message);
      }
      return;
    }

    console.log(`Streaming live build logs for ${id} (Ctrl+C to stop)...\n`);
    let printedLines = 0;
    let isFinished = false;

    while (!isFinished) {
      // Fetch logs
      let logs = '';
      try {
        const logRes = await client.get(`/build/${id}/logs`);
        logs = logRes.data;
      } catch (err) {
        // Ignore failures to retrieve logs during transient states
      }

      // Print new logs
      const logLines = logs.split('\n');
      if (logLines.length > printedLines) {
        const newLines = logLines.slice(printedLines, logLines.length - 1);
        newLines.forEach(line => console.log(line));
        printedLines = logLines.length - 1;
      }

      // Check status to stop loop when done
      try {
        const statusRes = await client.get(`/build/${id}`);
        const buildInfo = statusRes.data;

        if (buildInfo.status === 'completed') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`✔ BUILD SUCCESSFUL`);
          console.log(`========================================`);
          const isAab = buildInfo.buildType === 'aab' || buildInfo.downloadUrl.endsWith('.aab');
          console.log(`Download ${isAab ? 'AAB' : 'APK'}: ${buildInfo.downloadUrl}`);
          if (!isAab) {
            console.log(`\nScan the QR code below to download direct to your device:`);
            await printQRCode(buildInfo.downloadUrl);
          }
          console.log(`========================================\n`);
        } else if (buildInfo.status === 'failed') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`✖ BUILD FAILED`);
          console.log(`========================================`);
          console.log(`Reason: ${buildInfo.error || 'Unknown error'}`);
          console.log(`========================================\n`);
        } else if (buildInfo.status === 'cancelled') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`⚠ BUILD CANCELLED BY USER`);
          console.log(`========================================\n`);
        }
      } catch (err) {
        // Ignore status failures
      }

      if (!isFinished) {
        await new Promise(resolve => setTimeout(resolve, 2500));
      }
    }
  });
// Command: Cancel Build
program
  .command('cancel')
  .argument('<id>', 'Build ID to cancel')
  .description('Cancel a queued or active build job')
  .action(async (id) => {
    const client = getClient();
    try {
      console.log(`Sending cancellation request for build ${id}...`);
      const res = await client.post(`/build/${id}/cancel`);
      if (res.data && res.data.success) {
        console.log(`✔ Build ${id} cancelled successfully.`);
      } else {
        console.log(`✖ Failed to cancel build: ${res.data.error || 'Unknown response'}`);
      }
    } catch (err) {
      console.error('✖ Failed to cancel build:');
      if (err.response) {
        console.error(`  Server error (${err.response.status}):`, err.response.data.error || err.response.statusText);
      } else {
        console.error(`  Error message: ${err.message}`);
      }
    }
  });

// Command: Local Development Start
program
  .command('start')
  .description('Start local Metro bundler for MyBuild Previewer app')
  .option('-t, --tunnel', 'Launch dev server with a secure internet tunnel')
  .option('-c, --clear', 'Clear Metro bundler cache before starting')
  .action(async (options) => {
    // Verify Expo project
    const currentDir = process.cwd();
    const appJsonPath = path.join(currentDir, 'app.json');
    const packageJsonPath = path.join(currentDir, 'package.json');

    if (!fs.existsSync(appJsonPath) && !fs.existsSync(packageJsonPath)) {
      console.error('Error: This command must be run inside a valid Expo project folder.');
      return;
    }

    console.log('\n========================================');
    console.log('🚀 Starting MyBuild Local Metro Server');
    console.log(`   Mode: ${options.tunnel ? 'TUNNEL (Internet)' : 'LAN (Wi-Fi)'}`);
    console.log('========================================\n');

    // 1. Start the HTTP helper server for mobile-triggered builds
    const http = require('http');
    const helperServer = http.createServer(async (req, res) => {
      // Set CORS headers
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === '/build' && req.method === 'POST') {
        try {
          console.log('\n[MOBILE-TRIGGER] Received build request from mobile device...');
          const buildId = await startBuildSession(currentDir);
          const config = loadConfig();

          console.log(`[MOBILE-TRIGGER] Build successfully triggered. Build ID: ${buildId}`);
          
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: true,
            buildId,
            apiUrl: config.apiUrl,
            apiKey: config.apiKey
          }));
        } catch (err) {
          console.error('[MOBILE-TRIGGER] Build trigger failed:', err.message);
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({
            success: false,
            error: err.message
          }));
        }
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not Found' }));
    });

    helperServer.listen(8082, () => {
      console.log('📡 Mobile build helper server listening on port 8082');
    });

    // 2. Start Expo Metro
    const spawnArgs = ['expo', 'start', '--dev-client', '--scheme', 'mybuild'];
    if (options.tunnel) spawnArgs.push('--tunnel');
    if (options.clear) spawnArgs.push('--clear');

    const { spawn } = require('child_process');
    const child = spawn('npx', spawnArgs, {
      cwd: currentDir,
      stdio: 'inherit',
      shell: true
    });

    child.on('error', (err) => {
      console.error('✖ Failed to start Metro server:', err.message);
      helperServer.close();
    });

    child.on('close', (code) => {
      if (code !== 0) {
        console.log(`\nMetro server process exited with code ${code}.`);
      }
      helperServer.close();
    });
  });

program.parse(process.argv);
