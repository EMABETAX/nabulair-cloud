const express = require('express');
const cors = require('cors');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// FILE STATICI
// ============================================
app.use(express.static(__dirname));

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/remote', (req, res) => {
    res.sendFile(path.join(__dirname, 'remote.html'));
});

app.get('/dashboard.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/remote.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'remote.html'));
});

// ============================================
// VARIABILI D'AMBIENTE
// ============================================
const JWT_SECRET = process.env.JWT_SECRET;
// USA DATABASE_URL (endpoint privato, senza costi egress)
const DATABASE_URL = process.env.DATABASE_URL;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

if (!JWT_SECRET) {
    console.error('❌ ERRORE: JWT_SECRET non configurato!');
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error('❌ ERRORE: DATABASE_URL non configurato!');
    process.exit(1);
}

// ============================================
// DATABASE CONNECTION - ENDPOINT PRIVATO
// ============================================
// Configurazione ottimizzata per Railway (rete privata)
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: false,  // Nella rete privata Railway, SSL non è necessario
    // Configurazione ridotta per evitare timeout
    max: 3,                      // Solo 3 connessioni simultanee
    idleTimeoutMillis: 5000,     // Rilascia connessioni inutilizzate dopo 5 secondi
    connectionTimeoutMillis: 5000,
    statementTimeout: 10000,     // Timeout query 10 secondi
    queryTimeoutMillis: 10000,
    // Disabilita keepAlive che può causare problemi
    keepAlive: false,
    allowExitOnIdle: true
});

// Log della configurazione (senza mostrare la password)
console.log(`📊 Connessione DB: Endpoint privato Railway`);
console.log(`🔒 SSL: Disabilitato (rete privata)`);
console.log(`📊 Max connessioni: 3`);

// Gestione errori del pool
pool.on('error', (err) => {
    console.error('❌ Errore pool PostgreSQL:', err.message);
    // Non fare exit, lascia che il pool tenti di riprendersi
});

// ============================================
// FUNZIONE QUERY CON RETRY LIMITATO
// ============================================
async function queryWithRetry(query, params, maxRetries = 2) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await pool.query(query, params);
        } catch (error) {
            lastError = error;
            console.error(`Query fallita (tentativo ${i + 1}/${maxRetries}):`, error.message);
            
            if (i === maxRetries - 1) break;
            
            // Backoff breve
            await new Promise(resolve => setTimeout(resolve, 200 * (i + 1)));
        }
    }
    
    throw lastError;
}

// ============================================
// INIZIALIZZA DATABASE
// ============================================
async function initDatabase() {
    try {
        // Test connessione
        await pool.query('SELECT 1');
        console.log('✅ Database connesso (rete privata)');
        
        // Crea tabella machines
        await pool.query(`
            CREATE TABLE IF NOT EXISTS machines (
                id SERIAL PRIMARY KEY,
                mac_address VARCHAR(17) UNIQUE NOT NULL,
                machine_name VARCHAR(100),
                sta_ip VARCHAR(45),
                firmware_version VARCHAR(20),
                last_seen TIMESTAMP,
                status VARCHAR(20) DEFAULT 'offline',
                client_id INTEGER,
                installer_id INTEGER,
                water_ok BOOLEAN DEFAULT TRUE,
                insecticide_ok BOOLEAN DEFAULT TRUE,
                flow FLOAT DEFAULT 0
            )
        `).catch(e => console.log('Tabella machines già esistente'));
        
        // Crea tabella clients
        await pool.query(`
            CREATE TABLE IF NOT EXISTS clients (
                id SERIAL PRIMARY KEY,
                name VARCHAR(100),
                email VARCHAR(100),
                phone VARCHAR(50),
                address TEXT,
                telegram_chat_id VARCHAR(50)
            )
        `).catch(e => console.log('Tabella clients già esistente'));
        
        // Crea tabella users
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(50) UNIQUE NOT NULL,
                password_hash VARCHAR(255) NOT NULL,
                role VARCHAR(20) DEFAULT 'client',
                client_id INTEGER REFERENCES clients(id)
            )
        `).catch(e => console.log('Tabella users già esistente'));
        
        // Crea tabella alerts
        await pool.query(`
            CREATE TABLE IF NOT EXISTS alerts (
                id SERIAL PRIMARY KEY,
                machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL,
                status VARCHAR(20) DEFAULT 'active',
                message TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                resolved_at TIMESTAMP NULL
            )
        `).catch(e => console.log('Tabella alerts già esistente'));
        
        console.log('✅ Database inizializzato');
    } catch (err) {
        console.error('❌ Errore init database:', err.message);
        // Non uscire, riprova tra 30 secondi
        setTimeout(initDatabase, 30000);
    }
}

// Connessione iniziale con retry
let initialConnectAttempts = 0;
async function connectDB() {
    try {
        const client = await pool.connect();
        console.log('✅ Connesso a PostgreSQL (Railway rete privata)!');
        client.release();
        await initDatabase();
    } catch (err) {
        initialConnectAttempts++;
        console.error(`❌ Tentativo ${initialConnectAttempts} di connessione fallito:`, err.message);
        
        if (initialConnectAttempts < 10) {
            console.log(`🔄 Nuovo tentativo tra 10 secondi...`);
            setTimeout(connectDB, 10000);
        } else {
            console.error('❌ Impossibile connettersi al database dopo 10 tentativi');
        }
    }
}

connectDB();

// ============================================
// TELEGRAM NOTIFICHE
// ============================================
async function sendTelegramMessage(chatId, text) {
    if (!TELEGRAM_BOT_TOKEN || !chatId) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: 'HTML' })
        });
        const data = await res.json();
        if (!data.ok) console.error('Telegram error:', data.description);
    } catch (err) {
        console.error('Errore Telegram:', err.message);
    }
}

// ============================================
// MIDDLEWARE AUTH
// ============================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (!token) return res.status(401).json({ success: false, message: 'Token mancante' });
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ success: false, message: 'Token non valido' });
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Accesso negato' });
    }
    next();
};

// ============================================
// API ENDPOINTS
// ============================================

// Setup
app.post('/api/setup', async (req, res) => {
    try {
        const count = await queryWithRetry('SELECT COUNT(*) FROM users');
        if (parseInt(count.rows[0].count) > 0) {
            return res.status(403).json({ success: false, message: 'Setup già completato' });
        }
        const { username, password } = req.body;
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Credenziali richieste' });
        }
        const hash = await bcrypt.hash(password, 10);
        await queryWithRetry(
            'INSERT INTO users (username, password_hash, role) VALUES ($1, $2, $3)',
            [username.toLowerCase(), hash, 'admin']
        );
        res.json({ success: true, message: 'Admin creato' });
    } catch (error) {
        console.error('Errore setup:', error.message);
        res.status(500).json({ success: false, message: 'Errore server' });
    }
});

// Login
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Credenziali richieste' });
    }
    
    try {
        const result = await queryWithRetry('SELECT * FROM users WHERE username = $1', [username.toLowerCase()]);
        const user = result.rows[0];
        
        if (!user || !(await bcrypt.compare(password, user.password_hash))) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return res.status(401).json({ success: false, message: 'Credenziali non valide' });
        }
        
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, client_id: user.client_id },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({ success: true, token, user: { id: user.id, username: user.username, role: user.role, client_id: user.client_id } });
    } catch (error) {
        console.error('Errore login:', error.message);
        res.status(500).json({ success: false, message: 'Errore server' });
    }
});

// Me
app.get('/api/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// Machines
app.get('/api/machines', authenticateToken, async (req, res) => {
    try {
        let query = `
            SELECT m.*, c.name as client_name 
            FROM machines m
            LEFT JOIN clients c ON m.client_id = c.id
        `;
        let params = [];
        
        if (req.user.role === 'client') {
            query += ' WHERE m.client_id = $1';
            params.push(req.user.client_id);
        } else if (req.user.role === 'installer') {
            query += ' WHERE m.installer_id = $1';
            params.push(req.user.id);
        }
        
        query += ' ORDER BY m.last_seen DESC NULLS LAST';
        
        const result = await queryWithRetry(query, params);
        res.json({ success: true, machines: result.rows });
    } catch (error) {
        console.error('Errore GET machines:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento' });
    }
});

// Alerts
app.get('/api/alerts', authenticateToken, async (req, res) => {
    try {
        let query = `
            SELECT a.*, m.machine_name, c.name as client_name
            FROM alerts a
            JOIN machines m ON a.machine_id = m.id
            LEFT JOIN clients c ON m.client_id = c.id
            WHERE a.status = 'active'
        `;
        let params = [];
        
        if (req.user.role === 'client') {
            query += ' AND m.client_id = $1';
            params.push(req.user.client_id);
        } else if (req.user.role === 'installer') {
            query += ' AND m.installer_id = $1';
            params.push(req.user.id);
        }
        
        query += ' ORDER BY a.created_at DESC';
        
        const result = await queryWithRetry(query, params);
        res.json({ success: true, alerts: result.rows });
    } catch (error) {
        console.error('Errore GET alerts:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento' });
    }
});

// Resolve alert
app.post('/api/alerts/:id/resolve', authenticateToken, async (req, res) => {
    try {
        await queryWithRetry('UPDATE alerts SET status = $1, resolved_at = NOW() WHERE id = $2', ['resolved', req.params.id]);
        res.json({ success: true, message: 'Allarme risolto' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Machine detail
app.get('/api/machine/:id', authenticateToken, async (req, res) => {
    try {
        const result = await queryWithRetry(`
            SELECT m.*, c.name as client_name, c.email, c.phone, c.address
            FROM machines m
            LEFT JOIN clients c ON m.client_id = c.id
            WHERE m.id = $1
        `, [req.params.id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        res.json({ success: true, machine: result.rows[0] });
    } catch (error) {
        console.error('Errore GET machine:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento' });
    }
});

// Clients (admin only)
app.get('/api/clients', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM clients ORDER BY name');
        res.json({ success: true, clients: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/clients', authenticateToken, requireAdmin, async (req, res) => {
    const { name, email, phone, address, telegram_chat_id } = req.body;
    try {
        const result = await queryWithRetry(
            'INSERT INTO clients (name, email, phone, address, telegram_chat_id) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, email, phone, address, telegram_chat_id || null]
        );
        res.json({ success: true, client: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/clients/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { telegram_chat_id, name, email, phone, address } = req.body;
    try {
        await queryWithRetry(
            `UPDATE clients SET telegram_chat_id = $1, name = $2, email = $3, phone = $4, address = $5 WHERE id = $6`,
            [telegram_chat_id || null, name, email, phone, address, id]
        );
        res.json({ success: true, message: 'Cliente aggiornato' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Users (admin only)
app.get('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await queryWithRetry(`
            SELECT u.id, u.username, u.role, u.client_id, c.name as client_name 
            FROM users u 
            LEFT JOIN clients c ON u.client_id = c.id 
            ORDER BY u.id
        `);
        res.json({ success: true, users: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/users', authenticateToken, requireAdmin, async (req, res) => {
    const { username, password, role, client_id } = req.body;
    if (!username || !password || !role) {
        return res.status(400).json({ success: false, message: 'Dati mancanti' });
    }
    try {
        const hash = await bcrypt.hash(password, 10);
        await queryWithRetry(
            'INSERT INTO users (username, password_hash, role, client_id) VALUES ($1, $2, $3, $4)',
            [username.toLowerCase(), hash, role, client_id || null]
        );
        res.json({ success: true, message: 'Utente creato' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Assign machine
app.put('/api/machines/:id/assign', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { client_id, installer_id } = req.body;
    try {
        await queryWithRetry(
            'UPDATE machines SET client_id = $1, installer_id = $2 WHERE id = $3',
            [client_id || null, installer_id || null, id]
        );
        res.json({ success: true, message: 'Macchina aggiornata' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// Register ESP32
app.post('/api/register', async (req, res) => {
    const { mac_address, ip, version, machine_name } = req.body;
    
    if (!mac_address || !ip) {
        return res.status(400).json({ success: false, message: 'Dati mancanti' });
    }
    
    try {
        await queryWithRetry(
            `INSERT INTO machines (mac_address, sta_ip, firmware_version, machine_name, status, last_seen)
             VALUES ($1, $2, $3, $4, 'online', NOW())
             ON CONFLICT (mac_address) DO UPDATE SET 
             sta_ip = EXCLUDED.sta_ip, 
             machine_name = COALESCE(EXCLUDED.machine_name, machines.machine_name),
             last_seen = NOW(), 
             status = 'online'`,
            [mac_address.toUpperCase(), ip, version || '1.0', machine_name || 'NabulAir']
        );
        
        console.log(`📡 ESP32 registrato: ${mac_address}`);
        res.json({ success: true, message: 'Registrato' });
    } catch (error) {
        console.error('ERRORE REGISTER:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Ping ESP32
app.post('/api/ping', async (req, res) => {
    const { mac_address, water_ok, insecticide_ok, flow, status } = req.body;
    
    if (!mac_address) {
        return res.status(400).json({ success: false });
    }
    
    try {
        await queryWithRetry(
            `UPDATE machines 
             SET last_seen = NOW(), 
                 status = COALESCE($1, status),
                 water_ok = COALESCE($2, water_ok),
                 insecticide_ok = COALESCE($3, insecticide_ok),
                 flow = COALESCE($4, flow)
             WHERE mac_address = $5`,
            [status || 'online', water_ok, insecticide_ok, flow, mac_address]
        );
        
        res.json({ success: true });
    } catch (error) {
        console.error('Errore ping:', error.message);
        res.json({ success: false });
    }
});

// Health check
app.get('/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            timestamp: new Date().toISOString(),
            uptime: process.uptime(),
            db: 'connected'
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// Root
app.get('/', (req, res) => {
    res.json({ 
        message: 'NabulAir Cloud API', 
        version: '2.7',
        status: 'online',
        network: 'private (Railway)',
        features: ['Auth', 'Multi-role', 'Telegram Alerts', 'Admin Panel']
    });
});

// Reset emergency
app.post('/api/reset', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password || 'admin', 10);
    await queryWithRetry("UPDATE users SET password_hash = $1 WHERE username = 'admin'", [hash]);
    res.json({ success: true, message: 'Password resettata' });
});

// ============================================
// AVVIO SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`\n========================================`);
    console.log(`✅ NabulAir Cloud v2.7 avviato`);
    console.log(`========================================`);
    console.log(`🌐 Porta: ${PORT}`);
    console.log(`🔐 JWT_SECRET: ${JWT_SECRET ? '✅ Configurato' : '❌ MANCANTE'}`);
    console.log(`🗄️ Database: Endpoint PRIVATO (nessun costo egress)`);
    console.log(`🔒 SSL DB: Disabilitato (rete privata)`);
    console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Configurato' : '❌ DISABILITATO'}`);
    console.log(`📁 File statici: ${__dirname}`);
    console.log(`🔄 Auto-Retry: Attivo (max 2 tentativi)`);
    console.log(`========================================\n`);
});
