#!/usr/bin/env node

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const WebSocket = require('ws');
const axios = require('axios');
const FormData = require('form-data');

// ===== Configuration from Environment Variables =====
const CONFIG = {
    WS_SERVER: process.env.COMZY_WS_SERVER || 'wss://api.comzy.io:8191',
    BASE_DOMAIN: process.env.COMZY_BASE_DOMAIN || 'comzy.io',
    LOGIN_URL: process.env.COMZY_LOGIN_URL || 'https://comzy.io/login',
    ANONYMOUS_TIMEOUT: parseInt(process.env.COMZY_ANONYMOUS_TIMEOUT) || 60 * 60 * 1000, // 1 hour
    RECONNECT_DELAY: parseInt(process.env.COMZY_RECONNECT_DELAY) || 5000, // 5 seconds
    PING_INTERVAL: parseInt(process.env.COMZY_PING_INTERVAL) || 20000, // 20 seconds
};

// --- Colors for console output ---
const colors = {
    reset: '\x1b[0m',
    bright: '\x1b[1m',
    dim: '\x1b[2m',
    red: '\x1b[31m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    blue: '\x1b[34m',
    magenta: '\x1b[35m',
    cyan: '\x1b[36m',
    white: '\x1b[37m',
    gray: '\x1b[90m'
};

// --- Logging utilities ---
function log(message, color = colors.white) {
    console.log(`${color}${message}${colors.reset}`);
}

function logSuccess(message) {
    log(message, colors.green);
}

function logError(message) {
    log(message, colors.red);
}

function logWarning(message) {
    log(message, colors.yellow);
}

function logInfo(message) {
    log(message, colors.cyan);
}

function logDim(message) {
    log(message, colors.gray);
}

// --- Constants and paths ---
const HOME_DIR = os.homedir();
const COMZY_DIR = path.join(HOME_DIR, '.comzy');
const USER_FILE = path.join(COMZY_DIR, '.user');

// --- Ensure .comzy folder exists ---
function ensureComzyDir() {
    if (!fs.existsSync(COMZY_DIR)) {
        fs.mkdirSync(COMZY_DIR, { recursive: true });
    }
}

// --- Get stored token ---
function getStoredToken() {
    if (fs.existsSync(USER_FILE)) {
        return fs.readFileSync(USER_FILE, 'utf8').trim();
    }
    return '';
}

// --- Save token ---
function saveToken(token) {
    ensureComzyDir();
    fs.writeFileSync(USER_FILE, token.trim(), { mode: 0o600 }); // Secure file permissions
}

// --- Remove token (logout) ---
function removeToken() {
    if (fs.existsSync(USER_FILE)) {
        fs.unlinkSync(USER_FILE);
        logSuccess('Logged out successfully');
    } else {
        logWarning('No active session found');
    }
}

// --- Handle login ---
function handleLogin() {
    return new Promise((resolve) => {
        const rl = readline.createInterface({
            input: process.stdin,
            output: process.stdout
        });

        rl.question('Enter your authentication token: ', (inputToken) => {
            if (inputToken && inputToken.trim()) {
                saveToken(inputToken.trim());
                logSuccess('Authentication successful');
                resolve(inputToken.trim());
            } else {
                logWarning('No token provided. Running in anonymous mode.');
                logInfo(`To avoid connection timeout, login at: ${CONFIG.LOGIN_URL}`);
                resolve('');
            }
            rl.close();
        });
    });
}

// --- Show help ---
function showHelp() {
    console.log(`
Comzy - Secure tunnel to localhost

Usage:
  comzy [port]              Start tunnel on specified port (default: 3000)
  comzy login               Login with authentication token
  comzy logout              Logout and remove stored token
  comzy status              Show current authentication status
  comzy help                Show this help message

Examples:
  comzy 8080                Start tunnel on port 8080
  comzy                     Start tunnel on port 3000
  comzy login               Login with your token
  comzy logout              Logout from current session

Environment Variables:
  COMZY_WS_SERVER          WebSocket server URL (default: wss://api.comzy.io:8191)
  COMZY_BASE_DOMAIN        Base domain for tunnels (default: comzy.io)
  COMZY_LOGIN_URL          Login page URL (default: https://comzy.io/login)
  COMZY_ANONYMOUS_TIMEOUT  Anonymous session timeout in ms (default: 3600000)
  COMZY_RECONNECT_DELAY    Reconnection delay in ms (default: 5000)
  COMZY_PING_INTERVAL      Ping interval in ms (default: 20000)
`);
}

// --- Show status ---
function showStatus() {
    const token = getStoredToken();
    if (token) {
        logSuccess('Authenticated');
        logDim(`Token: ${token.substring(0, 8)}...`);
    } else {
        logWarning('Not authenticated (anonymous mode)');
        logInfo(`Login at: ${CONFIG.LOGIN_URL}`);
    }
    console.log(`\nConfiguration:`);
    logDim(`  Server: ${CONFIG.WS_SERVER}`);
    logDim(`  Domain: ${CONFIG.BASE_DOMAIN}`);
}

// --- Validate port ---
function validatePort(port) {
    const portNum = parseInt(port);
    if (isNaN(portNum) || portNum < 1 || portNum > 65535) {
        return null;
    }
    return portNum;
}

// --- Main function ---
async function main() {
    const args = process.argv.slice(2);
    const command = args[0];

    // Handle commands
    if (command === 'help' || command === '--help' || command === '-h') {
        showHelp();
        return;
    }

    if (command === 'login') {
        await handleLogin();
        return;
    }

    if (command === 'logout') {
        removeToken();
        return;
    }

    if (command === 'status') {
        showStatus();
        return;
    }

    // Start tunnel
    const localPort = validatePort(command) || 3000;
    if (!localPort) {
        logError('Invalid port number. Use a port between 1-65535');
        return;
    }

    let token = getStoredToken();
    const isAnonymous = !token;

    if (isAnonymous) {
        logWarning('Running in anonymous mode');
        logInfo(`Login at: ${CONFIG.LOGIN_URL} to avoid connection timeout`);
        logDim('Use "comzy login" to authenticate\n');
    }

    log(`Starting tunnel on localhost:${localPort}`, colors.bright);

    let ws;
    let pingInterval;
    let reconnectTimeout = null;
    let anonymousTimeout = null;
    let isShuttingDown = false;

    function connect() {
        if (isShuttingDown) return;

        ws = new WebSocket(CONFIG.WS_SERVER);

        ws.on('open', () => {
            logSuccess('Connected to tunnel server');

            ws.send(JSON.stringify({
                type: 'register',
                userId: token || 'anonymous',
                port: localPort            
            }));

            // Set anonymous timeout
            if (isAnonymous) {
                anonymousTimeout = setTimeout(() => {
                    console.log();
                    logWarning(`Anonymous session expired (${CONFIG.ANONYMOUS_TIMEOUT / 1000 / 60} minute limit)`);
                    logInfo(`Login at: ${CONFIG.LOGIN_URL} for unlimited access`);
                    cleanup();
                    process.exit(0);
                }, CONFIG.ANONYMOUS_TIMEOUT);
            }

            pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.ping();
                }
            }, CONFIG.PING_INTERVAL);
        });

        ws.on('close', () => {
            if (!isShuttingDown) {
                logWarning('Disconnected from tunnel server');
                cleanup();
                attemptReconnect();
            }
        });

        ws.on('error', (err) => {
            logError(`Connection error: ${err.message}`);
            ws.close();
        });

        ws.on('message', async (data) => {
            try {
                const request = JSON.parse(data);
                const { id, method, path, headers, body, files, type, alias } = request;

                if (type === 'registered') {
                    const generatedUrl = `https://${alias}.${CONFIG.BASE_DOMAIN}`;
                    console.log();
                    logSuccess('Tunnel established');
                    log(`Public URL:     ${colors.cyan}${generatedUrl}${colors.reset}`, colors.bright);
                    log(`Forwarding to:  ${colors.cyan}http://localhost:${localPort}${colors.reset}`, colors.bright);
                    
                    if (isAnonymous) {
                        logDim(`Anonymous session will expire in ${CONFIG.ANONYMOUS_TIMEOUT / 1000 / 60} minutes`);
                    }
                    
                    console.log();
                    logDim('Waiting for connections...');
                    console.log();
                    return;
                }

                // Prepare axios configuration
                let axiosConfig = {
                    method,
                    url: `http://localhost:${localPort}${path}`,
                    headers: { ...headers },
                    validateStatus: () => true,
                    responseType: 'arraybuffer',
                    timeout: 30000, // 30 second timeout
                };

                // Handle multipart/form-data with files
                if (headers['content-type']?.includes('multipart/form-data') && files?.length) {
                    const form = new FormData();

                    for (const key in body) {
                        form.append(key, body[key]);
                    }

                    for (const file of files) {
                        form.append(file.fieldname, Buffer.from(file.buffer.data), {
                            filename: file.originalname,
                            contentType: file.mimetype
                        });
                    }

                    axiosConfig.headers = form.getHeaders();
                    axiosConfig.data = form;
                } else {
                    axiosConfig.data = body;
                }

                logDim(`${method} ${path} -> localhost:${localPort}`);

                const response = await axios(axiosConfig);

                // Handle response body based on content type
                let responseBody;
                const contentType = response.headers['content-type'] || '';
                
                if (contentType.startsWith('image/') || 
                    contentType.startsWith('video/') || 
                    contentType.startsWith('audio/') || 
                    contentType.includes('application/octet-stream') ||
                    contentType.includes('application/pdf')) {
                    
                    // For binary data, convert to base64
                    responseBody = {
                        type: 'binary',
                        data: Buffer.from(response.data).toString('base64')
                    };
                } else {
                    // For text data, convert ArrayBuffer to string
                    responseBody = Buffer.from(response.data).toString('utf8');
                    
                    // Try to parse as JSON if it's JSON content
                    if (contentType.includes('application/json')) {
                        try {
                            responseBody = JSON.parse(responseBody);
                        } catch (e) {
                            // Keep as string if JSON parsing fails
                        }
                    }
                }

                ws.send(JSON.stringify({
                    id,
                    status: response.status,
                    headers: response.headers,
                    body: responseBody
                }));

            } catch (err) {
                logError(`Proxy error: ${err.message}`);

                try {
                    ws.send(JSON.stringify({
                        id: JSON.parse(data)?.id,
                        status: 500,
                        headers: { 'content-type': 'application/json' },
                        body: { error: 'Internal server error' }
                    }));
                } catch (sendErr) {
                    logError(`Failed to send error response: ${sendErr.message}`);
                }
            }
        });
    }

    function cleanup() {
        clearInterval(pingInterval);
        clearTimeout(anonymousTimeout);
        clearTimeout(reconnectTimeout);
    }

    function attemptReconnect() {
        if (reconnectTimeout || isShuttingDown) return;
        
        logInfo(`Reconnecting in ${CONFIG.RECONNECT_DELAY / 1000} seconds...`);
        reconnectTimeout = setTimeout(() => {
            reconnectTimeout = null;
            connect();
        }, CONFIG.RECONNECT_DELAY);
    }

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log();
        logInfo('Shutting down tunnel...');
        isShuttingDown = true;
        cleanup();
        if (ws) {
            ws.close();
        }
        process.exit(0);
    });

    process.on('SIGTERM', () => {
        console.log();
        logInfo('Received termination signal...');
        isShuttingDown = true;
        cleanup();
        if (ws) {
            ws.close();
        }
        process.exit(0);
    });

    connect();
}

main().catch(err => {
    logError(`Fatal error: ${err.message}`);
    process.exit(1);
});