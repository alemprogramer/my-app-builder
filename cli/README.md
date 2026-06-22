# mybuild-cli

Command Line Interface (CLI) for **mybuild**—a complete, self-hosted Expo mobile app build system (EAS clone) designed to compile React Native / Expo projects on your own VPS.

Using this CLI, you can upload local Expo project archives to your build server, compile release APKs/AABs asynchronously in the background, and stream logs in real-time, completely bypassing the need for local Android SDK, Java (JDK), or Gradle setup.

---

## 📦 Installation

Install the package globally via npm:

```bash
npm install -g mybuild-cli
```
*(Note: If you renamed your published package, replace `mybuild-cli` with your custom package name).*

---

## ⚙️ Setup & Configuration

### Quick Setup (Automatic)
The first time you run any command, the CLI will automatically detect if it is unconfigured and prompt you for:
1. **VPS API Server URL** (e.g., `http://your-vps-ip:4000`)
2. **API Access Key** (printed at the end of your VPS installation script)

### Manual Setup
You can manually configure or update the connection settings at any time:

```bash
mybuild init [url] [key]
```
Alternatively, just run `mybuild init` and answer the interactive prompts. Settings will be securely saved locally in `~/.mybuild/config.json`.

To update or verify your API Access Key only:
```bash
mybuild login [key]
```

---

## 🚀 How to Build your Android App

1. Navigate to the root directory of your Expo project on your laptop (the folder containing `app.json` or `package.json`):
   ```bash
   cd /path/to/your/expo-project
   ```

2. Trigger the build:
   ```bash
   mybuild build android
   ```

**What happens next?**
- The CLI archives your directory (automatically filtering out `node_modules`, `.git`, `.expo`, `android`, `ios`, and other heavy build directories).
- The zip payload is uploaded to your VPS API Server.
- The build task is enqueued to Redis and compiled sequentially.
- **Real-time logs** from `npm install`, `npx expo prebuild`, and `./gradlew assembleRelease` are streamed directly to your terminal.
- Once completed, a dynamic public download link for the release APK is returned!

---

## 💻 CLI Commands Cheatsheet

### Build & Control
* **Trigger Android Build:**
  ```bash
  mybuild build android
  ```
* **Cancel Active or Queued Build:**
  ```bash
  mybuild cancel <build-id>
  ```

### Query Status & History
* **List Last 10 Builds:**
  ```bash
  mybuild status
  ```
* **View Single Build Details & Download Link:**
  ```bash
  mybuild status <build-id>
  ```

### View & Watch Logs
* **Print Static Build Logs:**
  ```bash
  mybuild logs <build-id>
  ```
* **Watch Live Build Logs (Reconnect Stream):**
  If your connection times out or disconnects, you can reconnect and stream active logs live:
  ```bash
  mybuild logs <build-id> -w
  ```
  *(or `--watch`)*

---

## ⚡ Direct SSH/SCP Download (Workaround)
If downloading through the browser gets throttled or fails due to network instability on port 4000, run this command in your **local terminal** (not on the VPS) to download the APK directly over port 22 (SSH) into your `Downloads` folder:

```bash
scp root@YOUR_VPS_IP:/opt/mybuild/data/builds/<build-id>/*.apk ~/Downloads/
```

---

## 📄 License
MIT
