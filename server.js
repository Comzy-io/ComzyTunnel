const express = require('express');
const http = require('http');
const fs = require('fs');
const https = require('https');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const { randomUUID, randomBytes } = require('crypto');
const path = require('path');

const app = express();
const upload = multer(); // Handles multipart/form-data

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(upload.any()); // Adds req.body and req.files for form-data

// ===== Configuration =====
const USE_HTTPS = process.env.USE_HTTPS === 'true';
const CERT_PATH = process.env.CERT_PATH || '';
const KEY_PATH = process.env.KEY_PATH || '';

let serverOptions = null;
if (USE_HTTPS && fs.existsSync(CERT_PATH) && fs.existsSync(KEY_PATH)) {
    serverOptions = {
        cert: fs.readFileSync(CERT_PATH),
        key: fs.readFileSync(KEY_PATH),
    };
}

// Custom domain mapping (optional)
const customDomainToAlias = new Map([
  // Add custom domains here, e.g.:
  // ['test.yourdomain.com', 'site-c0f1bbaee4ed'],
]);

// ===== In-Memory Storage =====
const clients = new Map(); // Map<UUID, ws>
const aliasToUUID = new Map(); // Map<alias, UUID>
const uuidToAlias = new Map(); // Map<UUID, alias>

// ===== Alias Generation =====
const PREFIXES = ['client', 'user', 'web', 'site', 'app', 'people'];
let lastPrefixIndex = -1;

function shortAlias() {
    let alias;
    do {
        lastPrefixIndex = (lastPrefixIndex + 1) % PREFIXES.length;
        const prefix = PREFIXES[lastPrefixIndex];
        alias = `${prefix}-${randomBytes(6).toString('hex')}`; // trillions of combinations
    } while (aliasToUUID.has(alias)); // retry if duplicate
    return alias;
}

// ===== Dashboard WebSocket Server =====
const dashboardClients = new Set(); // Track all connected dashboard sockets

function setupDashboardWS(server) {
    const adminWSS = new WebSocketServer({ server });

    adminWSS.on('connection', (ws) => {
        console.log('[DASHBOARD] Connected');
        dashboardClients.add(ws);

        ws.on('close', () => {
            console.log('[DASHBOARD] Disconnected');
            dashboardClients.delete(ws);
        });

        // Send initial state
        sendActiveUrlsToClient(ws);
    });

    return adminWSS;
}

function getCurrentActiveAliases() {
    const active = [];
    
    for (const [alias, uuid] of aliasToUUID.entries()) {
        const client = clients.get(uuid);
        if (client && client.readyState === 1) {
            active.push(`https://${alias}.comzy.io/`);
        }
    }

    return active;
}

function broadcastActiveUrls() {
    const payload = {
        type: 'active_urls',
        data: getCurrentActiveAliases(),
    };

    const message = JSON.stringify(payload);

    for (const ws of dashboardClients) {
        if (ws.readyState === 1) {
            ws.send(message);
        }
    }
}

function sendActiveUrlsToClient(ws) {
    const payload = {
        type: 'active_urls',
        data: getCurrentActiveAliases(),
    };
    ws.send(JSON.stringify(payload));
}

// Broadcast active URLs every 5 seconds
setInterval(() => {
    broadcastActiveUrls();
}, 5000);

// ===== Main WebSocket Server Setup =====
const server = USE_HTTPS && serverOptions 
    ? https.createServer(serverOptions, app)
    : http.createServer(app);

const wss = new WebSocketServer({ server });

// ===== WebSocket Connection Handling =====
wss.on('connection', (ws) => {
    console.log('Client connected via WebSocket');

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg.toString());

            if (data.type === 'register') {
                const clientUUID = randomUUID();
                const alias = shortAlias();

                // Store client connection
                clients.set(clientUUID, ws);
                aliasToUUID.set(alias, clientUUID);
                uuidToAlias.set(clientUUID, alias);

                ws._clientUUID = clientUUID;

                console.log(`Registered client: uuid=${clientUUID}, alias=${alias}`);
                console.log(`Your URL is: https://${alias}.comzy.io/`);

                ws.send(JSON.stringify({
                    type: 'registered',
                    uuid: clientUUID,
                    alias: alias
                }));
            }
        } catch (err) {
            console.error('Invalid WebSocket message:', err);
        }
    });

    ws.on('close', () => {
        console.log('Client disconnected');
        if (ws._clientUUID) {
            const alias = uuidToAlias.get(ws._clientUUID);

            clients.delete(ws._clientUUID);
            aliasToUUID.delete(alias);
            uuidToAlias.delete(ws._clientUUID);
        }
    });
});

// ===== ACME Challenge Support (for Let's Encrypt) =====
const challengePath = path.join(__dirname, '.well-known', 'acme-challenge');
if (fs.existsSync(challengePath)) {
    app.use('/.well-known/acme-challenge', express.static(challengePath));
}

// ===== Extract Alias from Subdomain =====
app.use((req, res, next) => {
    const host = req.headers.host; // e.g., client-abcd1234.comzy.io
    let alias = host?.split('.')[0]; // Take 'client-abcd1234'
    
    // Check for custom domain mapping
    if (customDomainToAlias.has(host)) {
        alias = customDomainToAlias.get(host);
    }
    
    const uuid = aliasToUUID.get(alias);
    req.clientUUID = uuid;
    next();
});

// ===== Handle All Routes via Subdomain =====
app.all(/.*/, async (req, res) => {
    console.log("----------------------------------------------------------------------------------------------------------------------------------------------");
    
    const uuid = req.clientUUID;
    const subPath = req.path;

    console.log(`[HTTP] Incoming: ${req.method} ${req.originalUrl} (UUID: ${uuid})`);

    if (!uuid) {
        console.warn(`[WARN] Invalid alias or client not registered`);
        return res.status(400).json({ error: 'Invalid URL or client not connected' });
    }

    const client = clients.get(uuid);

    if (!client || client.readyState !== 1) {
        console.warn(`[WARN] Client not connected for UUID: ${uuid}`);
        return res.status(503).json({ error: 'Client not connected' });
    }

    const requestId = Date.now() + Math.random();

    const message = {
        id: requestId,
        method: req.method,
        path: subPath,
        headers: req.headers,
        body: req.body,
        files: req.files || [],
    };

    client.send(JSON.stringify(message));

    const onResponse = async (data) => {
        try {
            const response = JSON.parse(data);

            if (response.id !== requestId) return;

            client.off('message', onResponse);
            
            const contentType = response.headers?.['content-type'] || 'application/json';

            res.status(response.status || 200);
            res.set('Content-Type', contentType);

            if (contentType.includes('application/json')) {
                res.json(response.body);
            } else {
                res.send(response.body);
            }
        } catch (err) {
            console.error(`[ERROR] Failed to process client response`, err);
            res.status(500).json({ error: 'Internal server error' });
        }
    };

    client.on('message', onResponse);
});

// ===== Start Servers =====
const PORT = process.env.PORT || 8190;
const DASHBOARD_PORT = process.env.DASHBOARD_PORT || 8192;

server.listen(PORT, () => {
    console.log(`Main server running on ${USE_HTTPS ? 'https' : 'http'}://localhost:${PORT}`);
});

// Dashboard WebSocket Server (separate port)
if (USE_HTTPS && serverOptions) {
    const adminWSServer = https.createServer(serverOptions);
    setupDashboardWS(adminWSServer);
    adminWSServer.listen(DASHBOARD_PORT, () => {
        console.log(`Dashboard WebSocket server running on wss://localhost:${DASHBOARD_PORT}`);
    });
} else {
    const adminWSServer = http.createServer();
    setupDashboardWS(adminWSServer);
    adminWSServer.listen(DASHBOARD_PORT, () => {
        console.log(`Dashboard WebSocket server running on ws://localhost:${DASHBOARD_PORT}`);
    });
}