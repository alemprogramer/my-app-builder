const { Command } = require('commander');
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const axios = require('axios');
const FormData = require('form-data');
const archiver = require('archiver');

const CONFIG_DIR = path.join(os.homedir(), '.mybuild');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

const program = new Command();
program
  .name('mybuild')
  .description('CLI tool for self-hosted Expo mobile app builds')
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
    timeout: 30000
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

// Command: Build Android
program
  .command('build')
  .argument('<platform>', 'target build platform (currently only "android")')
  .description('Build project release package on your self-hosted VPS')
  .action(async (platform) => {
    if (platform !== 'android') {
      console.error('Error: Only "android" target platform is currently supported.');
      return;
    }

    // 1. Verify Expo project
    const currentDir = process.cwd();
    const appJsonPath = path.join(currentDir, 'app.json');
    const packageJsonPath = path.join(currentDir, 'package.json');

    if (!fs.existsSync(appJsonPath) && !fs.existsSync(packageJsonPath)) {
      console.error('Error: This command must be run inside a valid Expo project folder (containing app.json or package.json).');
      return;
    }

    // Read app/project name
    let projectName = 'ExpoApp';
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
      // Fallback to ExpoApp
    }

    const client = getClient();
    const tempZipPath = path.join(CONFIG_DIR, 'mybuild-temp.zip');

    try {
      console.log('📦 Archiving local project directory (excluding node_modules/build artifacts)...');
      await zipDirectory(currentDir, tempZipPath);
      console.log(`✔ Archive created successfully (${(fs.statSync(tempZipPath).size / (1024 * 1024)).toFixed(2)} MB).`);

      // 2. Upload archive
      console.log('🚀 Uploading project package to build server...');
      const form = new FormData();
      form.append('projectName', projectName);
      form.append('platform', 'android');
      form.append('file', fs.createReadStream(tempZipPath));

      const uploadRes = await client.post('/build', form, {
        headers: form.getHeaders(),
        maxContentLength: Infinity,
        maxBodyLength: Infinity
      });

      const { buildId } = uploadRes.data;
      console.log(`✔ Project uploaded. Assigned Build ID: ${buildId}`);
      console.log(`Streaming build logs...\n`);

      // 3. Poll logs & status
      let printedLines = 0;
      let isFinished = false;

      while (!isFinished) {
        // Wait 2.5s between updates
        await new Promise(resolve => setTimeout(resolve, 2500));

        // Fetch logs
        let logs = '';
        try {
          const logRes = await client.get(`/build/${buildId}/logs`);
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

        // Check overall status
        const statusRes = await client.get(`/build/${buildId}`);
        const buildInfo = statusRes.data;

        if (buildInfo.status === 'completed') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`✔ BUILD SUCCESSFUL`);
          console.log(`========================================`);
          console.log(`Download APK: ${buildInfo.downloadUrl}`);
          console.log(`========================================\n`);
        } else if (buildInfo.status === 'failed') {
          isFinished = true;
          console.log(`\n========================================`);
          console.log(`✖ BUILD FAILED`);
          console.log(`========================================`);
          console.log(`Reason: ${buildInfo.error || 'Unknown error'}`);
          console.log(`========================================\n`);
        }
      }

    } catch (error) {
      console.error('✖ Build initialization failed:');
      if (error.response) {
        console.error(`  Server error (${error.response.status}):`, error.response.data.error || error.response.statusText);
      } else {
        console.error(`  Error message: ${error.message}`);
      }
    } finally {
      // Clean up local temp zip
      if (fs.existsSync(tempZipPath)) {
        fs.unlinkSync(tempZipPath);
      }
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
        console.log(String('ID').padEnd(25) + String('PROJECT').padEnd(20) + String('STATUS').padEnd(12) + String('CREATED'));
        console.log(''.padEnd(70, '-'));
        builds.slice(0, 10).forEach(b => {
          console.log(
            String(b.id).padEnd(25) + 
            String(b.projectName).padEnd(20) + 
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
  .description('Fetch and display build logs from the server')
  .action(async (id) => {
    const client = getClient();
    try {
      const res = await client.get(`/build/${id}/logs`);
      console.log(res.data);
    } catch (err) {
      console.error('✖ Failed to fetch logs:', err.message);
    }
  });

program.parse(process.argv);
