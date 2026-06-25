const fs = require('fs');
const path = require('path');

const DB_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const DB_FILE = path.join(DB_DIR, 'db.json');

// Initialize database
function init() {
  if (!fs.existsSync(DB_DIR)) {
    fs.mkdirSync(DB_DIR, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ builds: [] }, null, 2), 'utf8');
  }
}

// Read database
function read() {
  init();
  try {
    const data = fs.readFileSync(DB_FILE, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file, returning empty state:', err);
    return { builds: [] };
  }
}

// Write database
function write(data) {
  init();
  try {
    fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (err) {
    console.error('Error writing database file:', err);
  }
}

const db = {
  getBuilds() {
    const data = read();
    return data.builds || [];
  },

  getBuild(id) {
    const builds = this.getBuilds();
    return builds.find(b => b.id === id) || null;
  },

  createBuild({ id, projectName, platform, status = 'queued', buildType = null }) {
    const data = read();
    const newBuild = {
      id,
      projectName,
      platform,
      status,
      buildType,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      logsPath: null,
      downloadUrl: null,
      error: null
    };
    data.builds.unshift(newBuild); // Put newest builds first
    write(data);
    return newBuild;
  },

  updateBuild(id, updates) {
    const data = read();
    const buildIndex = data.builds.findIndex(b => b.id === id);
    if (buildIndex === -1) return null;

    data.builds[buildIndex] = {
      ...data.builds[buildIndex],
      ...updates,
      updatedAt: new Date().toISOString()
    };
    write(data);
    return data.builds[buildIndex];
  }
};

module.exports = db;
