require('dotenv').config();
const express = require('express');
const http = require('http');
const fs = require('fs');
const https = require('https');
const { WebSocketServer } = require('ws');
const multer = require('multer');
const { randomUUID, randomBytes } = require('crypto');
const mysql = require('mysql2/promise');
const path = require('path');

const app = express();
const upload = multer();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(upload.any());

// ===== Configuration from Environment Variables =====
const CONFIG = {
    // SSL Certificate paths
    SSL_CERT_PATH: process.env.SSL_CERT_PATH || '/etc/letsencrypt/live/api.comzy.io/fullchain.pem',
    SSL_KEY_PATH: process.env.SSL_KEY_PATH || '/etc/letsencrypt/live/api.comzy.io/privkey.pem',
    
    // Database configuration
    DB_HOST: process.env.DB_HOST || '127.0.0.1',
    DB_USER: process.env.DB_USER || 'root',
    DB_PASSWORD: process.env.DB_PASSWORD,
    DB_NAME: process.env.DB_NAME || 'comzy',
    DB_CONNECTION_LIMIT: parseInt(process.env.DB_CONNECTION_LIMIT) || 10,
    
    // Server ports
    HTTP_PORT: parseInt(process.env.HTTP_PORT) || 8190,
    WS_PORT: parseInt(process.env.WS_PORT) || 8191,
    ADMIN_WS_PORT: parseInt(process.env.ADMIN_WS_PORT) || 8192,
    
    // Domain configuration
    BASE_DOMAIN: process.env.BASE_DOMAIN || 'comzy.io',
    
    // Limits
    MAX_ALIASES_PER_USER: parseInt(process.env.MAX_ALIASES_PER_USER) || 5,
    
    // ACME challenge path
    ACME_CHALLENGE_PATH: process.env.ACME_CHALLENGE_PATH || path.join(__dirname, '.well-known', 'acme-challenge'),
};

// Validate required environment variables
if (!CONFIG.DB_PASSWORD) {
    console.error('ERROR: DB_PASSWORD environment variable is required');
    process.exit(1);
}

// ===== SSL Configuration =====
let serverOptions;
try {
    serverOptions = {
        cert: fs.readFileSync(CONFIG.SSL_CERT_PATH),
        key: fs.readFileSync(CONFIG.SSL_KEY_PATH),
    };
} catch (error) {
    console.error('ERROR: Failed to read SSL certificates:', error.message);
    console.error('Please ensure SSL_CERT_PATH and SSL_KEY_PATH are correctly configured');
    process.exit(1);
}

// ===== Custom Domain Mapping (Load from environment or file) =====
const customDomainToAlias = new Map();

// Load custom domains from environment variable (format: domain1:alias1,domain2:alias2)
if (process.env.CUSTOM_DOMAINS) {
    const domains = process.env.CUSTOM_DOMAINS.split(',');
    domains.forEach(entry => {
        const [domain, alias] = entry.split(':');
        if (domain && alias) {
            customDomainToAlias.set(domain.trim(), alias.trim());
        }
    });
}

// ===== Server Initialization =====
const wsServer = https.createServer(serverOptions);
const adminWSServer = https.createServer(serverOptions);

// ===== Database Pool =====
const dbPool = mysql.createPool({
    host: CONFIG.DB_HOST,
    user: CONFIG.DB_USER,
    password: CONFIG.DB_PASSWORD,
    database: CONFIG.DB_NAME,
    waitForConnections: true,
    connectionLimit: CONFIG.DB_CONNECTION_LIMIT,
});

// Test database connection on startup
(async () => {
    try {
        const connection = await dbPool.getConnection();
        console.log('✓ Database connection successful');
        connection.release();
    } catch (error) {
        console.error('ERROR: Database connection failed:', error.message);
        process.exit(1);
    }
})();

const server = http.createServer(app);
const wss = new WebSocketServer({ server: wsServer });
const adminWSS = new WebSocketServer({ server: adminWSServer });

// ===== In-Memory Storage =====
const clients = new Map(); // Map<UUID, ws>
const aliasToUUID = new Map(); // Map<alias, UUID>
const uuidToAlias = new Map(); // Map<UUID, alias>
const userIdToAliases = new Map(); // Map<userId, Set<alias>>

// ===== Alias Generation =====
const PREFIXES = ['client', 'user', 'web', 'site', 'app', 'people'];
let lastPrefixIndex = -1;

function shortAlias() {
    let alias;
    do {
        lastPrefixIndex = (lastPrefixIndex + 1) % PREFIXES.length;
        const prefix = PREFIXES[lastPrefixIndex];
        alias = `${prefix}-${randomBytes(6).toString('hex')}`;
    } while (aliasToUUID.has(alias));
    return alias;
}

// ===== Dashboard WebSocket =====
const dashboardClients = new Set();

adminWSS.on('connection', (ws) => {
    console.log('[DASHBOARD] Client connected');
    dashboardClients.add(ws);

    ws.on('close', () => {
        console.log('[DASHBOARD] Client disconnected');
        dashboardClients.delete(ws);
    });

    sendActiveUrlsToClient(ws);
});

function getCurrentActiveUrlsPerUser() {
    const data = {};

    for (const [userId, aliases] of userIdToAliases.entries()) {
        const active = [...aliases].filter(alias => {
            const uuid = aliasToUUID.get(alias);
            const client = clients.get(uuid);
            return client && client.readyState === 1;
        }).map(alias => `https://${alias}.${CONFIG.BASE_DOMAIN}/`);

        if (active.length > 0) {
            data[userId] = active;
        }
    }

    return data;
}

function broadcastActiveUrls() {
    const payload = {
        type: 'active_urls',
        data: getCurrentActiveUrlsPerUser(),
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
        data: getCurrentActiveUrlsPerUser(),
    };
    ws.send(JSON.stringify(payload));
}

// Broadcast active URLs every 5 seconds
setInterval(broadcastActiveUrls, 5000);

// ===== WebSocket Connection Handling =====
wss.on('connection', (ws) => {
    console.log('[WS] New connection established');

    ws.on('message', async (msg) => {
        try {
            const data = JSON.parse(msg.toString());

            if (data.type === 'register' && data.userId && data.port) {
                const clientUUID = randomUUID();
                const userId = data.userId.trim().toLowerCase();
                const port = data.port;
                let alias;

                try {
                    // Check if user exists in users table
                    const [userRows] = await dbPool.query(
                        'SELECT 1 FROM users WHERE user_token = ?',
                        [userId]
                    );

                    if (userRows.length === 0) {
                        console.warn(`[AUTH] User "${userId}" not found, generating temporary alias`);
                        alias = shortAlias();
                    } else {
                        if (!userIdToAliases.has(userId)) {
                            userIdToAliases.set(userId, new Set());
                        }
                        const userAliases = userIdToAliases.get(userId);

                        if (userAliases.size >= CONFIG.MAX_ALIASES_PER_USER) {
                            alias = shortAlias();
                            console.warn(`[LIMIT] User ${userId} reached alias limit, generating new: ${alias}`);
                        } else {
                            // Check if alias already exists for this user
                            const [aliasRows] = await dbPool.query(
                                'SELECT alias FROM user_aliases WHERE user_id = ? AND port = ?',
                                [userId, port]
                            );

                            if (aliasRows.length > 0) {
                                alias = aliasRows[0].alias;
                                console.log(`[DB] Found existing alias: ${alias}`);
                            } else {
                                // Generate new alias and store it
                                do {
                                    alias = shortAlias();
                                } while (aliasToUUID.has(alias));

                                await dbPool.query(
                                    'INSERT INTO user_aliases (user_id, alias, port) VALUES (?, ?, ?)',
                                    [userId, alias, port]
                                );

                                console.log(`[DB] New alias created: ${alias}`);
                            }
                        }
                        userAliases.add(alias);
                    }
                } catch (err) {
                    console.error('[DB ERROR]', err);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Internal server error while processing registration.'
                    }));
                    return;
                }

                // Final setup
                clients.set(clientUUID, ws);
                aliasToUUID.set(alias, clientUUID);
                uuidToAlias.set(clientUUID, alias);
                ws._clientUUID = clientUUID;

                console.log(`[REGISTERED] userId=${userId}, port=${port}, alias=${alias}`);

                ws.send(JSON.stringify({
                    type: 'registered',
                    uuid: clientUUID,
                    alias: alias
                }));
            }
        } catch (err) {
            console.error('[WS ERROR] Invalid message:', err);
        }
    });

    ws.on('close', () => {
        console.log('[WS] Connection closed');
        if (ws._clientUUID) {
            const alias = uuidToAlias.get(ws._clientUUID);

            clients.delete(ws._clientUUID);
            aliasToUUID.delete(alias);
            uuidToAlias.delete(ws._clientUUID);

            // Remove alias from user tracking
            for (const [userId, aliases] of userIdToAliases.entries()) {
                if (aliases.has(alias)) {
                    aliases.delete(alias);
                    if (aliases.size === 0) {
                        userIdToAliases.delete(userId);
                    }
                    break;
                }
            }
        }
    });
});

// ===== ACME Challenge Support =====
app.use('/.well-known/acme-challenge', express.static(CONFIG.ACME_CHALLENGE_PATH));

// ===== Extract Alias from Subdomain =====
app.use((req, res, next) => {
    const host = req.headers.host;
    let alias = host?.split('.')[0];

    if (customDomainToAlias.has(host)) {
        alias = customDomainToAlias.get(host);
    }

    const uuid = aliasToUUID.get(alias);
    req.clientUUID = uuid;
    next();
});

// ===== Handle All Routes via Subdomain =====
app.all(/.*/, async (req, res) => {
    const uuid = req.clientUUID;
    const subPath = req.path;
    const alias = uuidToAlias.get(uuid);
    const port = req.headers['x-forwarded-port'] || 0;

    console.log(`[HTTP] ${req.method} ${req.originalUrl} (UUID: ${uuid})`);

    if (!uuid) {
        console.warn('[WARN] Invalid alias or client not registered');
        return res.status(400).json({ error: 'Invalid URL' });
    }

    const bytesIn = JSON.stringify(req.headers).length + JSON.stringify(req.body || {}).length;

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
            const bytesOut = Buffer.byteLength(
                typeof response.body === 'string' ? response.body : JSON.stringify(response.body)
            );

            try {
                await dbPool.query(
                    `INSERT INTO api_requests (alias, port, method, path, status_code, bytes_in, bytes_out)
                     VALUES (?, ?, ?, ?, ?, ?, ?)`,
                    [alias, port, req.method, subPath, response.status || 200, bytesIn, bytesOut]
                );
            } catch (err) {
                console.error('[DB ERROR] Failed to log API request:', err);
            }

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
            console.error('[ERROR] Failed to process client response', err);
            res.status(500).json({ error: 'Internal server error' });
        }
    };

    client.on('message', onResponse);
});

// ===== Start Servers =====
server.listen(CONFIG.HTTP_PORT, () => {
    console.log(`✓ HTTP + WS Server running on port ${CONFIG.HTTP_PORT}`);
});

wsServer.listen(CONFIG.WS_PORT, () => {
    console.log(`✓ WebSocket server running on port ${CONFIG.WS_PORT}`);
});

adminWSServer.listen(CONFIG.ADMIN_WS_PORT, () => {
    console.log(`✓ Dashboard WebSocket server running on port ${CONFIG.ADMIN_WS_PORT}`);
});

// ===== Graceful Shutdown =====
process.on('SIGINT', async () => {
    console.log('\n[SHUTDOWN] Closing connections...');
    
    // Close all WebSocket connections
    for (const [uuid, client] of clients.entries()) {
        client.close();
    }
    
    // Close database pool
    await dbPool.end();
    
    console.log('[SHUTDOWN] Cleanup complete');
    process.exit(0);
});