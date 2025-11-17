# Comzy Tunnel Service - Complete Technical Documentation

## Overview

**Comzy** is a tunneling service similar to ngrok/localtunnel that exposes local development servers to the internet through secure WebSocket connections. It consists of two main components:

- **Server** (`server.js`): Handles incoming HTTP requests, manages WebSocket connections, assigns subdomain aliases, and routes traffic
- **Client** (`client.js`): CLI tool that connects local servers to the Comzy cloud infrastructure

### Key Features
- Dynamic subdomain allocation (e.g., `client-abc123.comzy.io`)
- User authentication with token-based system
- Anonymous mode with 1-hour timeout
- Custom domain mapping support
- File upload handling via multipart/form-data
- Real-time dashboard for monitoring active tunnels
- Request/response logging to MySQL database

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                          INTERNET                                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ HTTPS Request
                              │ (e.g., https://client-abc123.comzy.io/api/users)
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                    REVERSE PROXY / LOAD BALANCER                     │
│                    (Nginx with Let's Encrypt SSL)                    │
└─────────────────────────────────────────────────────────────────────┘
                              │
                ┌─────────────┼─────────────┐
                │             │             │
                ▼             ▼             ▼
     ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
     │ HTTP Server  │ │   WS Server  │ │  Admin WS    │
     │  Port 8190   │ │  Port 8191   │ │  Port 8192   │
     └──────────────┘ └──────────────┘ └──────────────┘
            │                 │                 │
            │                 │                 │
     ┌──────▼─────────────────▼─────────────────▼──────┐
     │           COMZY SERVER (Node.js)                 │
     │                                                   │
     │  ┌─────────────────────────────────────────┐    │
     │  │   In-Memory Data Structures             │    │
     │  │                                          │    │
     │  │  • clients: Map<UUID, WebSocket>        │    │
     │  │  • aliasToUUID: Map<alias, UUID>        │    │
     │  │  • uuidToAlias: Map<UUID, alias>        │    │
     │  │  • userIdToAliases: Map<userId, Set>    │    │
     │  │  • customDomainToAlias: Map             │    │
     │  └─────────────────────────────────────────┘    │
     │                                                   │
     │  ┌─────────────────────────────────────────┐    │
     │  │      WebSocket Message Handler          │    │
     │  │   (Routes HTTP → Client via WS)         │    │
     │  └─────────────────────────────────────────┘    │
     └───────────────────────┬───────────────────────────┘
                             │
                    ┌────────┴────────┐
                    ▼                 ▼
          ┌──────────────────┐  ┌──────────────┐
          │  MySQL Database  │  │  Dashboard   │
          │                  │  │  Clients     │
          │  Tables:         │  │  (Browser    │
          │  • users         │  │   WebSocket) │
          │  • user_aliases  │  └──────────────┘
          │  • api_requests  │
          └──────────────────┘
                    
                    ▲
                    │ WebSocket Connection (wss://)
                    │
          ┌─────────┴──────────┐
          │  COMZY CLIENT      │
          │  (CLI Tool)        │
          │                    │
          │  • Connects to WS  │
          │  • Registers port  │
          │  • Proxies traffic │
          └─────────┬──────────┘
                    │
                    │ HTTP Proxy
                    ▼
          ┌──────────────────┐
          │  Local Dev       │
          │  Server          │
          │  (localhost:3000)│
          └──────────────────┘
```

---

## Code Flow Analysis

### 1. Client Registration Flow

```
┌─────────────┐
│ User runs   │
│ $ comzy 3000│
└──────┬──────┘
       │
       ▼
┌──────────────────────────────┐
│ 1. Check for stored token    │
│    (~/.comzy/.user)           │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ 2. Connect to WSS server     │
│    wss://api.comzy.io:8191   │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ 3. Send registration message │
│    {                          │
│      type: 'register',        │
│      userId: token,           │
│      port: 3000               │
│    }                          │
└──────┬───────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ SERVER PROCESSING:                  │
│                                     │
│ 4a. Validate userId in DB           │
│ 4b. Check existing aliases          │
│ 4c. Generate/retrieve alias         │
│ 4d. Store mappings in memory        │
│     • clients.set(uuid, ws)         │
│     • aliasToUUID.set(alias, uuid)  │
│     • uuidToAlias.set(uuid, alias)  │
│ 4e. Insert into user_aliases table  │
└──────┬──────────────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ 5. Server responds:          │
│    {                          │
│      type: 'registered',      │
│      uuid: '...',             │
│      alias: 'client-abc123'   │
│    }                          │
└──────┬───────────────────────┘
       │
       ▼
┌──────────────────────────────┐
│ 6. Client displays URL:      │
│    https://client-abc123     │
│          .comzy.io/           │
└──────────────────────────────┘
```

### 2. HTTP Request Flow

```
┌────────────────────────────┐
│ Browser/API Client makes   │
│ request:                   │
│ GET https://client-abc123  │
│     .comzy.io/api/data     │
└──────┬─────────────────────┘
       │
       ▼
┌────────────────────────────┐
│ 1. Nginx/SSL Termination   │
│    → Port 8190 (HTTP)      │
└──────┬─────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 2. Express Middleware extracts   │
│    alias from subdomain:         │
│    host = 'client-abc123.comzy'  │
│    alias = 'client-abc123'       │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 3. Lookup UUID from alias:       │
│    uuid = aliasToUUID.get(alias) │
│    req.clientUUID = uuid         │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 4. Find WebSocket client:        │
│    client = clients.get(uuid)    │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 5. Serialize HTTP request:       │
│    {                              │
│      id: timestamp + random,     │
│      method: 'GET',              │
│      path: '/api/data',          │
│      headers: {...},             │
│      body: {...}                 │
│    }                              │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 6. Send via WebSocket to client  │
│    client.send(JSON.stringify...) │
└──────┬───────────────────────────┘
       │
       ▼
┌─────────────────────────────────────┐
│ CLIENT RECEIVES MESSAGE:            │
│                                     │
│ 7a. Parse request                   │
│ 7b. Forward to localhost:3000       │
│     via axios                       │
│ 7c. Get response from local server  │
│ 7d. Serialize response              │
│     {                               │
│       id: matching_id,              │
│       status: 200,                  │
│       headers: {...},               │
│       body: {...}                   │
│     }                               │
│ 7e. Send back via WebSocket         │
└──────┬──────────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 8. Server receives response      │
│    via 'message' event listener  │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 9. Log to database:              │
│    INSERT INTO api_requests...   │
└──────┬───────────────────────────┘
       │
       ▼
┌──────────────────────────────────┐
│ 10. Send HTTP response to        │
│     original requester           │
│     res.status(200).send(body)   │
└──────────────────────────────────┘
```

### 3. Binary Data Handling Flow

For images, PDFs, videos:

**Client Side:**
1. Detects binary content-type
2. Converts ArrayBuffer → Base64
3. Wraps in `{ type: 'binary', data: base64String }`
4. Sends to server

**Server Side:**
1. Receives response with binary data
2. Extracts base64 string
3. Decodes and sends to HTTP client

---

### Scaling Solutions

#### Architecture for 100,000+ Concurrent Connections

```
                    ┌──────────────────┐
                    │  Load Balancer   │
                    │  (HAProxy/Nginx) │
                    └────────┬─────────┘
                             │
            ┌────────────────┼────────────────┐
            │                │                │
            ▼                ▼                ▼
    ┌──────────────┐ ┌──────────────┐ ┌──────────────┐
    │ Server Node 1│ │ Server Node 2│ │ Server Node N│
    └──────┬───────┘ └──────┬───────┘ └──────┬───────┘
           │                │                │
           └────────────────┼────────────────┘
                            │
                  ┌─────────▼─────────┐
                  │  Redis Cluster    │
                  │                   │
                  │  • Session store  │
                  │  • Pub/Sub        │
                  │  • UUID→Alias map │
                  └─────────┬─────────┘
                            │
                  ┌─────────▼─────────┐
                  │  PostgreSQL       │
                  │  (with replicas)  │
                  └───────────────────┘
```



## Features

- **Secure WebSocket Tunneling** - End-to-end encrypted connections
- **Custom Subdomains** - Get persistent subdomains for your services
- **Multi-User Support** - User authentication and session management
- **Dashboard Monitoring** - Real-time monitoring of active tunnels
- **File Upload Support** - Handle multipart/form-data requests
- **Auto-Reconnection** - Automatic reconnection on connection loss
- **Anonymous Mode** - Quick testing without authentication

## Prerequisites

- Node.js >= 14.x
- MySQL/MariaDB database
- SSL certificates (Let's Encrypt recommended)
- Domain with DNS configured
## Quick Start

### Option 1: Use Comzy Hosted Service (Recommended for Quick Start)

Get started in seconds without any installation or setup:

1. **Download the client**
   ```bash
   curl -O https://raw.githubusercontent.com/Comzy-io/ComzyTunnel/main/comzy.js
   ```
   **Note:** you can download the bin file accoridng to your os and architecher and go run it directly

2. **Run directly with Node.js**
   ```bash
   node comzy.js 3000  # Expose localhost:3000
   ```
   or just run donwloaded bin file

3. **Get your public URL instantly**
   ```
   ✓ Tunnel created successfully!
   Public URL: https://client-abc123.comzy.io
   ```

**That's it!** No installation, no configuration, no server setup required. The hosted service at `comzy.io` handles everything for you.Refer this for more info [Comzy Docs](https://docs.comzy.io/docs/getting-started/comzy-tunnel/how-it-works)


## Installation

### Server Setup

1. **Clone the repository**
   ```bash
   git clone https://github.com/yourusername/comzy.git
   cd comzy
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   nano .env  # Edit with your configuration
   ```

4. **Set up the database**
   ```sql
   CREATE DATABASE comzy;
   USE comzy;

   CREATE TABLE users (
       id INT PRIMARY KEY AUTO_INCREMENT,
       user_token VARCHAR(255) UNIQUE NOT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
   );

   CREATE TABLE user_aliases (
       id INT PRIMARY KEY AUTO_INCREMENT,
       user_id VARCHAR(255) NOT NULL,
       alias VARCHAR(255) UNIQUE NOT NULL,
       port INT NOT NULL,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_user_id (user_id),
       INDEX idx_alias (alias)
   );

   CREATE TABLE api_requests (
       id INT PRIMARY KEY AUTO_INCREMENT,
       alias VARCHAR(255) NOT NULL,
       port INT NOT NULL,
       method VARCHAR(10) NOT NULL,
       path VARCHAR(1024) NOT NULL,
       status_code INT NOT NULL,
       bytes_in INT DEFAULT 0,
       bytes_out INT DEFAULT 0,
       created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
       INDEX idx_alias (alias),
       INDEX idx_created_at (created_at)
   );
   ```

5. **Obtain SSL certificates**
   ```bash
   # Using certbot for Let's Encrypt
   sudo certbot certonly --standalone -d api.comzy.io
   ```

6. **Start the server**
   ```bash
   npm start
   # or for development
   npm run dev
   ```

### Client Setup

1. **Install the client globally**
   ```bash
   npm install -g comzy-client
   ```

2. **Configure client (optional)**
   ```bash
   # Set custom server
   export COMZY_WS_SERVER=wss://your-server.com:8191
   ```

3. **Login (optional)**
   ```bash
   comzy login
   ```

4. **Start tunneling**
   ```bash
   comzy 3000  # Expose localhost:3000
   ```


### Server Environment Variables

```bash
# SSL Configuration
SSL_CERT_PATH=/path/to/fullchain.pem
SSL_KEY_PATH=/path/to/privkey.pem

# Database (REQUIRED)
DB_PASSWORD=your_secure_password

# Optional Settings
DB_HOST=127.0.0.1
DB_USER=root
DB_NAME=comzy
HTTP_PORT=8190
WS_PORT=8191
ADMIN_WS_PORT=8192
BASE_DOMAIN=comzy.io
MAX_ALIASES_PER_USER=5
```

### Client Environment Variables

```bash
COMZY_WS_SERVER=wss://api.comzy.io:8191
COMZY_BASE_DOMAIN=comzy.io
COMZY_LOGIN_URL=https://comzy.io/login
COMZY_ANONYMOUS_TIMEOUT=3600000  # 1 hour in ms
```

## Usage

### Basic Usage

```bash
# Start tunnel on default port (3000)
comzy

# Start tunnel on specific port
comzy 8080

# Login with token
comzy login

# Check status
comzy status

# Logout
comzy logout
```

### Custom Domains

Add custom domains in `.env`:

```bash
CUSTOM_DOMAINS=custom.example.com:client-abc123,another.com:site-xyz789
```

## Monitoring

Access the admin dashboard at `wss://your-server:8192` to monitor:
- Active connections
- User sessions
- Request statistics
- Traffic metrics

## Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

### Security Vulnerabilities

If you discover a security vulnerability, please email hello@comzy.io or create new issue

## License

This project is licensed under the MIT License - see the LICENSE file for details.

## Important Notes

### For Open Source Contributors

- **Never commit sensitive data** (passwords, tokens, certificates)
- Always use `.env` for configuration
- Follow the security best practices
- Review code for security issues before submitting PRs

### For Self-Hosting

- Use strong passwords
- Keep software updated
- Monitor logs regularly
- Implement proper backup strategy
- Consider security audits

## Support

- Documentation: https://docs.comzy.io

## Acknowledgments

Inspired by ngrok and other tunneling solutions.

---

**Remember**: Security is everyone's responsibility. Always follow best practices and keep your installation secure.


