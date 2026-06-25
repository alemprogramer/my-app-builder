# mybuild: Self-Hosted Build System for Expo & React Native Apps

**English** | [বাংলা সংস্করণ (Bangla Version)](README.bn.md)

A complete self-hosted mobile app build system (compatible with Expo/React Native projects, similar to Expo EAS) designed to compile Android APKs/AABs on your own Ubuntu VPS. With this setup, you don't need any local Android SDK, Java (JDK), or Gradle configuration on your local laptop.

---

## 🚀 How to Use (Step-by-Step Guide)

### Step 1: Push Code to GitHub (From your local laptop)

First, push your local code to your GitHub repository. Your repository has already been configured as `alemprogramer/my-app-builder`. Run the following commands in your local terminal:

```bash
git add .
git commit -m "feat: setup self-hosted builder"
git branch -M main
git push -u origin main
```

---

### Step 2: VPS Server Setup (One-Command Setup)

To run compiles on your server, you need an Ubuntu VPS. We recommend at least **4GB RAM** and **2 CPU Cores**.

1. SSH into your VPS server:
   ```bash
   ssh root@your_vps_ip
   ```

2. Run the one-command installer script directly on the server:
   ```bash
   curl -sL https://raw.githubusercontent.com/alemprogramer/my-app-builder/main/scripts/install.sh | bash
   ```

3. Once the script finishes installing, you will see a configuration message like this:
   ```text
   ==================================================
   ✔ installation completed successfully!
   ==================================================
   
   ✔ Backend running on http://123.45.67.89:4000
   ✔ Worker running under PM2
   ✔ Redis connected
   
   API Server URL:  http://123.45.67.89:4000
   API Access Key:  a1b2c3d4e5f6g7h8...
   ```
   **Important:** Write down the **API Server URL** and **API Access Key**.

---

### Step 3: Setup CLI on your laptop

Your local laptop only needs Node.js installed. You do not need Android Studio or JDK.

1. Install the CLI globally from your terminal:
   ```bash
   npm install -g mybuilder-cli
   ```
   *(During installation, the CLI will automatically ask you to input your **VPS URL** and **API Access Key** to complete the setup.)*

2. If you are unable to enter inputs during installation, you can initialize or reconfigure settings later:
   ```bash
   mybuild init http://YOUR_VPS_IP:4000 YOUR_API_ACCESS_KEY
   ```

---

### Step 4: Build your App (Build Android APK)

1. Navigate to the root directory of any Expo project on your laptop (the folder containing `app.json` or `package.json`).
2. Run the build command:
   ```bash
   mybuild build android
   ```
   *(You will be prompted to choose between **Release** and **Debug** build types. You can also specify it directly using the `--type` flag, e.g., `mybuild build android --type debug`)*

**How it works:**
- The CLI archives your project files into a zip payload (automatically excluding `node_modules`, `.git`, etc.).
- The zip file is uploaded to the VPS API Server.
- The server queues the job to Redis.
- The background build worker extracts the project, runs `npm install` (or yarn/bun), executes `npx expo prebuild`, and runs `./gradlew assembleRelease` to compile.
- Real-time build logs are streamed directly to your laptop's terminal.
- Once compilation completes, you'll receive a direct download link for the release APK.

* **Cancel a Build (Cancel Build):**
   To cancel an active build or remove a build from the queue, run:
   ```bash
   mybuild cancel <build-id>
   ```

* **Reconnect to Live Logs (Watch Logs Live):**
   If your connection drops, reconnect and stream the logs of an active build:
   ```bash
   mybuild logs <build-id> -w
   ```

---

## 💻 CLI Commands Cheatsheet

### 1. Connection & Authentication Setup
* **Initialize or update connection settings:**
  ```bash
  mybuild init http://YOUR_VPS_IP:4000 YOUR_API_KEY
  ```
* **Update the API Key only:**
  ```bash
  mybuild login YOUR_API_KEY
  ```

### 2. Build Commands
* **Start Android build (must run from Expo project root):**
  ```bash
  mybuild build android
  # or skip prompt by passing build type directly:
  mybuild build android --type <release|debug>
  ```
* **Cancel active or queued build:**
  ```bash
  mybuild cancel <build-id>
  ```

### 3. Check Status & History
* **List the last 10 builds:**
  ```bash
  mybuild status
  ```
* **View detailed status and download link for a specific build:**
  ```bash
  mybuild status <build-id>
  ```

### 4. Fetch Logs
* **View the full log file once build is finished:**
  ```bash
  mybuild logs <build-id>
  ```
* **Stream live logs for a running build:**
  ```bash
  mybuild logs <build-id> -w
  ```

### 5. 🚀 Direct SSH/SCP Download (Fast Alternative)
If you have slow download speeds or the download fails on port 4000 due to network constraints, run this command in your **local terminal** (not on the VPS) to download the APK directly over port 22 (SSH) to your **Downloads** folder:
```bash
scp root@YOUR_VPS_IP:/opt/mybuild/data/builds/<build-id>/*.apk ~/Downloads/
```

---

## 🛠 VPS Server Maintenance (PM2 Commands)

If you need to inspect or restart processes on your VPS, SSH into the server and use these commands:

* **View running processes status:**
  ```bash
  pm2 status
  ```

* **Inspect live PM2 logs output:**
  ```bash
  pm2 logs
  ```

* **Restart backend API and worker processes:**
  ```bash
  pm2 restart all
  ```

* **Data directory path on VPS:** `/opt/mybuild/data`
* **Raw build log file path on VPS:** `/opt/mybuild/data/builds/<build-id>/logs.txt`

---

## ⚖️ Legal Disclaimer & Trademark Notice

**mybuild** is an independent, unofficial open-source project. 

- **Expo** and **EAS (Expo Application Services)** are trademarks of **650 Industries, Inc.** (referred to as Expo).
- This project is **not** affiliated with, sponsored by, endorsed by, or in any way officially connected to 650 Industries, Inc., Expo, or EAS.
- Any references to "Expo", "EAS", or related terminology are used solely for descriptive purposes to indicate compatibility with apps developed using the Expo SDK.
