# mybuilder-cli

Command Line Interface (CLI) for **mybuild**—a complete, self-hosted build system (similar to Expo EAS) designed to compile React Native & Expo projects on your own VPS.

Using this CLI, you can upload local React Native/Expo project archives to your build server, compile release APKs/AABs asynchronously in the background, and stream logs in real-time, completely bypassing the need for local Android SDK, Java (JDK), or Gradle setup.

---

## 🖥️ VPS Server Setup (One-Command Setup)

Before using the CLI, you must set up your backend API and worker on an Ubuntu VPS (recommended: minimum 4GB RAM, 2 Core CPU).

To install and run the entire build system on your VPS with a single command, SSH into your VPS and run:
```bash
curl -sL https://raw.githubusercontent.com/alemprogramer/my-app-builder/main/scripts/install.sh | bash
```
Once the installation completes, copy the **API Server URL** and **API Access Key** printed in the terminal.

---

## 📦 Installation

Install the package globally via npm:

```bash
npm install -g mybuilder-cli
```

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
   *(You can select either **Release APK**, **Release AAB**, or **Debug APK** from the interactive menu, or specify the build type directly using the `--type` flag, e.g., `mybuild build android --type aab`)*

**What happens next?**
- The CLI archives your directory (automatically filtering out `node_modules`, `.git`, `.expo`, `android`, `ios`, and other heavy build directories).
- The zip payload is uploaded to your VPS API Server.
- The build task is enqueued to Redis and compiled sequentially.
- **Real-time logs** from `npm install`, `npx expo prebuild`, and `./gradlew` (running `assembleRelease`, `bundleRelease`, or `assembleDebug` based on type) are streamed directly to your terminal.
- Once completed, a dynamic public download link for the build artifact is returned!

---

## 💻 CLI Commands Cheatsheet

### Build & Control
* **Trigger Android Build:**
  ```bash
  mybuild build android
  # or bypass the interactive menu:
  mybuild build android --type <release|debug|aab>
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
If downloading through the browser gets throttled or fails due to network instability on port 4000, run this command in your **local terminal** (not on the VPS) to download the artifact directly over port 22 (SSH) into your `Downloads` folder:

```bash
scp root@YOUR_VPS_IP:/opt/mybuild/data/builds/<build-id>/* ~/Downloads/
```

---

## 📄 License
MIT

---

## ⚖️ Legal Disclaimer & Trademark Notice

**mybuild** and **mybuilder-cli** are independent, unofficial open-source projects.

- **Expo** and **EAS (Expo Application Services)** are trademarks of **650 Industries, Inc.** (referred to as Expo).
- These projects are **not** affiliated with, sponsored by, endorsed by, or in any way officially connected to 650 Industries, Inc., Expo, or EAS.
- Any references to "Expo", "EAS", or related terminology are used solely for descriptive purposes to indicate compatibility with apps developed using the Expo SDK.
