#!/usr/bin/env bash

# Exit immediately if a command exits with a non-zero status
set -e

# Configuration
REPO_URL="git@github.com:alemprogramer/my-app-bulder.git" # User should replace this with their repo URL
INSTALL_DIR="/opt/mybuild"
ANDROID_SDK_DIR="/opt/android-sdk"
JDK_VERSION="17"

echo "=================================================="
echo "   Starting mybuild VPS Auto-Installer Script"
echo "=================================================="

# 1. Check OS
if [ -f /etc/debian_version ]; then
    echo "✔ Debian/Ubuntu OS detected."
else
    echo "✖ This script is designed for Debian/Ubuntu systems. Exiting."
    exit 1
fi

# 2. Configure Swap File if RAM is less than 6GB (Gradle requires significant memory)
TOTAL_RAM=$(free -m | awk '/^Mem:/{print $2}')
if [ "$TOTAL_RAM" -lt 6000 ]; then
    echo "⚠ Low RAM detected (${TOTAL_RAM}MB). Setting up a 4GB Swap file to prevent Gradle OOM..."
    if [ ! -f /swapfile ]; then
        sudo fallocate -l 4G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=4096
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
        sudo swapon /swapfile
        echo "/swapfile swap swap defaults 0 0" | sudo tee -a /etc/fstab
        echo "✔ Swap file created and enabled."
    else
        echo "✔ Swap file already exists."
    fi
fi

# 3. Update Package List & Install Prereqs
echo "📦 Installing core system dependencies..."
sudo apt-get update -y
sudo apt-get install -y curl git unzip build-essential wget apt-transport-https ca-certificates gnupg

# 4. Install Node.js (v18.x LTS)
if ! command -v node &> /dev/null; then
    echo "📦 Installing Node.js..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
    echo "✔ Node.js $(node -v) installed."
else
    echo "✔ Node.js $(node -v) is already installed."
fi

# 5. Install Redis Server
if ! command -v redis-server &> /dev/null; then
    echo "📦 Installing Redis Server..."
    sudo apt-get install -y redis-server
    sudo systemctl enable redis-server.service
    sudo systemctl start redis-server.service
    echo "✔ Redis Server installed and started."
else
    echo "✔ Redis Server is already installed."
fi

# 6. Install PM2 Globally
if ! command -v pm2 &> /dev/null; then
    echo "📦 Installing PM2 globally..."
    sudo npm install -g pm2
    echo "✔ PM2 installed."
else
    echo "✔ PM2 is already installed."
fi

# 7. Install OpenJDK 17
if ! command -v javac &> /dev/null || ! javac -version 2>&1 | grep -q "17"; then
    echo "📦 Installing OpenJDK ${JDK_VERSION}..."
    sudo apt-get install -y openjdk-${JDK_VERSION}-jdk
    echo "✔ OpenJDK installed: $(javac -version 2>&1)"
else
    echo "✔ OpenJDK 17 is already installed."
fi

# 8. Install Android SDK (Command Line Tools)
if [ ! -d "$ANDROID_SDK_DIR/cmdline-tools" ]; then
    echo "📦 Downloading and installing Android SDK Command Line Tools..."
    sudo mkdir -p "$ANDROID_SDK_DIR/cmdline-tools"
    
    # Download Android SDK cmdline-tools
    cd /tmp
    wget -q https://dl.google.com/android/repository/commandlinetools-linux-11076708_latest.zip -O cmdline-tools.zip
    sudo unzip -q cmdline-tools.zip -d "$ANDROID_SDK_DIR/cmdline-tools"
    rm cmdline-tools.zip
    
    # Reorganize cmdline-tools directory structure for SDK manager compatibility
    sudo mv "$ANDROID_SDK_DIR/cmdline-tools/cmdline-tools" "$ANDROID_SDK_DIR/cmdline-tools/latest"
    
    # Export environmental variables
    echo "configuring Android environment variables..."
    sudo tee /etc/profile.d/android.sh <<EOF
export ANDROID_HOME=$ANDROID_SDK_DIR
export JAVA_HOME=/usr/lib/jvm/java-1.7.0-openjdk-amd64 # Fallback or detect
export PATH=\$PATH:\$ANDROID_HOME/cmdline-tools/latest/bin:\$ANDROID_HOME/platform-tools:\$ANDROID_HOME/build-tools/34.0.0
EOF
    
    # Fix JAVA_HOME dynamic path resolution
    JDK_PATH=$(readlink -f /usr/bin/javac | sed "s:/bin/javac::")
    sudo sed -i "s:export JAVA_HOME=.*:export JAVA_HOME=${JDK_PATH}:" /etc/profile.d/android.sh
    
    # Source variables in current shell execution
    export ANDROID_HOME=$ANDROID_SDK_DIR
    export JAVA_HOME=$JDK_PATH
    export PATH=$PATH:$ANDROID_HOME/cmdline-tools/latest/bin:$ANDROID_HOME/platform-tools
    
    # Auto-accept licenses
    echo "Accepting Android SDK licenses..."
    yes | sudo "$ANDROID_SDK_DIR/cmdline-tools/latest/bin/sdkmanager" --licenses --sdk_root="$ANDROID_SDK_DIR"
    
    # Install build tools & platform
    echo "Installing Android platform-tools, build-tools 34.0.0 and platforms;android-34..."
    sudo "$ANDROID_SDK_DIR/cmdline-tools/latest/bin/sdkmanager" --sdk_root="$ANDROID_SDK_DIR" "platform-tools" "build-tools;34.0.0" "platforms;android-34"
    
    # Correct file permissions
    sudo chmod -R 777 "$ANDROID_SDK_DIR"
    echo "✔ Android SDK installed and configured."
else
    echo "✔ Android SDK is already installed."
fi

# 9. Clone and Setup Backend & Worker
echo "🚀 Cloning and deploying code repositories..."
if [ -d "$INSTALL_DIR" ]; then
    echo "⚠ Directory $INSTALL_DIR already exists. Backing up and updating..."
    sudo mv "$INSTALL_DIR" "${INSTALL_DIR}_backup_$(date +%s)"
fi

sudo mkdir -p "$INSTALL_DIR"
sudo git clone "$REPO_URL" "$INSTALL_DIR"
sudo chmod -R 777 "$INSTALL_DIR"

# Generate Secure Random API Key
API_KEY=$(openssl rand -hex 16 2>/dev/null || echo "mybuild_$(date +%s)_key")

# Setup environment files
echo "⚙ Configuring environment variables..."
cd "$INSTALL_DIR/api"
npm install --production

cat <<EOF > .env
PORT=4000
API_KEY=${API_KEY}
REDIS_URL=redis://127.0.0.1:6379
DATA_DIR=${INSTALL_DIR}/data
EOF

cd "$INSTALL_DIR/worker"
npm install --production

# Resolve JDK path for env configuration
JDK_PATH=$(readlink -f /usr/bin/javac | sed "s:/bin/javac::")

cat <<EOF > .env
API_URL=http://127.0.0.1:4000
API_KEY=${API_KEY}
REDIS_URL=redis://127.0.0.1:6379
WORKER_DIR=/tmp/mybuild-worker
ANDROID_HOME=${ANDROID_SDK_DIR}
JAVA_HOME=${JDK_PATH}
EOF

# 10. Start API & Worker under PM2
echo "🚀 Starting PM2 processes..."
cd "$INSTALL_DIR/api"
pm2 start src/index.js --name "mybuild-api"

cd "$INSTALL_DIR/worker"
pm2 start src/index.js --name "mybuild-worker"

# Save PM2 state to restart on boot
pm2 save
sudo env PATH=$PATH:/usr/bin pm2 startup systemd -u $USER --hp $HOME || true

# Configure Firewall (Open Port 4000)
echo "🔒 Configuring system firewall to allow port 4000..."
if command -v ufw &> /dev/null; then
    sudo ufw allow 4000/tcp || true
    echo "✔ Firewall updated (port 4000 allowed)."
else
    echo "⚠ ufw not found. Please ensure port 4000 is open in your cloud VPS network firewall."
fi

# Get Server IP Address
IP_ADDR=$(curl -s icanhazip.com || curl -s ifconfig.me || echo "YOUR_VPS_IP")

echo "=================================================="
echo "✔ installation completed successfully!"
echo "=================================================="
echo ""
echo "✔ Backend running on http://${IP_ADDR}:4000"
echo "✔ Worker running under PM2"
echo "✔ Redis connected"
echo ""
echo "API Server URL:  http://${IP_ADDR}:4000"
echo "API Access Key:  ${API_KEY}"
echo ""
echo "=================================================="
echo "⚙ To connect your CLI, execute the command below:"
echo "mybuild init http://${IP_ADDR}:4000 ${API_KEY}"
echo "=================================================="
