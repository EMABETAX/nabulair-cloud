const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const tls = require('tls');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// ============================================
// FILE STATICI (HTML, CSS, JS)
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
// DATABASE CONNECTION - CONFIGURAZIONE SSL CORRETTA PER RAILWAY
// ============================================
// Railway richiede SSL ma con una configurazione specifica
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: {
        rejectUnauthorized: false,  // Accetta certificati self-signed
        // Configurazione specifica per Railway
        ca: process.env.PG_SSL_CA || undefined,
        cert: process.env.PG_SSL_CERT || undefined,
        key: process.env.PG_SSL_KEY || undefined,
    },
    // Configurazioni di connessione
    max: 10,                       // Riduci il numero di connessioni
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 30000, // Aumenta timeout
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000,
    // Aggiungi statement timeout per evitare query bloccate
    statementTimeout: 30000,
    // Query timeout
    queryTimeoutMillis: 30000,
});

// Gestione errori del pool
pool.on('error', (err) => {
    console.error('❌ Errore nel pool PostgreSQL:', err.message);
    // Non terminare il processo, lascia che il pool tenti di riconnettersi
});

// Funzione per riconnessione con backoff
let reconnectAttempts = 0;
const maxReconnectAttempts = 10;

async function reconnectDatabase() {
    if (reconnectAttempts >= maxReconnectAttempts) {
        console.error('❌ Massimi tentativi di riconnessione raggiunti');
        return;
    }
    
    reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, reconnectAttempts), 30000);
    
    console.log(`🔄 Tentativo di riconnessione ${reconnectAttempts}/${maxReconnectAttempts} tra ${delay}ms...`);
    
    setTimeout(async () => {
        try {
            await pool.connect();
            console.log('✅ Riconnessione al database riuscita!');
            reconnectAttempts = 0;
        } catch (err) {
            console.error('❌ Fallita riconnessione:', err.message);
            reconnectDatabase();
        }
    }, delay);
}

// ============================================
// FUNZIONE PER VERIFICARE CONNESSIONE DB
// ============================================
async function ensureDbConnection() {
    try {
        await pool.query('SELECT 1');
        return true;
    } catch (error) {
        console.error('❌ Database disconnesso:', error.message);
        reconnectDatabase();
        return false;
    }
}

// ============================================
// QUERY CON RETRY AUTOMATICO
// ============================================
async function queryWithRetry(query, params, maxRetries = 3) {
    let lastError;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            // Assicurati che la connessione sia attiva prima della query
            await ensureDbConnection();
            return await pool.query(query, params);
        } catch (error) {
            lastError = error;
            console.error(`Tentativo ${i + 1}/${maxRetries} fallito:`, error.message);
            
            if (i === maxRetries - 1) break;
            
            // Backoff esponenziale con jitter
            const delay = Math.min(1000 * Math.pow(2, i) + Math.random() * 500, 10000);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
    
    throw lastError;
}

// ============================================
// INIZIALIZZA DATABASE (Tabelle e trigger)
// ============================================
async function initDatabase() {
    try {
        // Verifica connessione
        await pool.query('SELECT 1');
        
        // Crea tabella alerts se non esiste
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
        `);
        
        // Aggiungi colonne water_ok e insecticide_ok a machines se non esistono
        await pool.query(`
            ALTER TABLE machines ADD COLUMN IF NOT EXISTS water_ok BOOLEAN DEFAULT TRUE;
            ALTER TABLE machines ADD COLUMN IF NOT EXISTS insecticide_ok BOOLEAN DEFAULT TRUE;
            ALTER TABLE machines ADD COLUMN IF NOT EXISTS flow FLOAT DEFAULT 0;
        `).catch(e => console.log('Colonne machines già esistenti', e.message));

        // Aggiungi telegram_chat_id a clients
        await pool.query(`
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50);
        `).catch(e => console.log('Colonna telegram_chat_id già esistente'));

        // Aggiungi client_id a users
        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
        `).catch(e => console.log('Colonna client_id su users già esistente'));
        
        console.log('✅ Database inizializzato correttamente');
    } catch (err) {
        console.error('❌ Errore init database:', err.message);
        // Riprova tra 10 secondi
        setTimeout(initDatabase, 10000);
    }
}

// Connessione iniziale
(async function connectDB() {
    try {
        const client = await pool.connect();
        console.log('✅ Connesso a PostgreSQL su Railway!');
        client.release();
        await initDatabase();
    } catch (err) {
        console.error('❌ Errore connessione iniziale DB:', err.message);
        console.log('🔄 Nuovo tentativo tra 10 secondi...');
        setTimeout(connectDB, 10000);
    }
})();

// ============================================
// TELEGRAM NOTIFICHE
// ============================================
async function sendTelegramMessage(chatId, text) {
    if (!TELEGRAM_BOT_TOKEN || !chatId) return;
    try {
        const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: chatId,
                text: text,
                parse_mode: 'HTML'
            })
        });
        const data = await res.json();
        if (!data.ok) {
            console.error('Telegram API error:', data.description);
        }
    } catch (err) {
        console.error('Errore invio Telegram:', err.message);
    }
}

// ============================================
// MIDDLEWARE AUTH
// ============================================
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    
    if (!token) {
        return res.status(401).json({ success: false, message: 'Token mancante' });
    }
    
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) {
            return res.status(403).json({ success: false, message: 'Token non valido' });
        }
        req.user = user;
        next();
    });
};

const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ success: false, message: 'Accesso negato: richiesto ruolo admin' });
    }
    next();
};

// ============================================
// API SETUP
// ============================================
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
        res.json({ success: true, message: 'Admin creato con successo' });
    } catch (error) {
        console.error('Errore setup:', error.message);
        res.status(500).json({ success: false, message: 'Errore server' });
    }
});

// ============================================
// API LOGIN
// ============================================
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Credenziali richieste' });
    }
    
    try {
        const result = await queryWithRetry(
            'SELECT * FROM users WHERE username = $1',
            [username.toLowerCase()]
        );
        
        const user = result.rows[0];
        
        if (!user) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return res.status(401).json({ success: false, message: 'Credenziali non valide' });
        }
        
        const passwordValid = await bcrypt.compare(password, user.password_hash);
        
        if (!passwordValid) {
            await new Promise(resolve => setTimeout(resolve, 100));
            return res.status(401).json({ success: false, message: 'Credenziali non valide' });
        }
        
        const token = jwt.sign(
            { id: user.id, username: user.username, role: user.role, client_id: user.client_id },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, role: user.role, client_id: user.client_id }
        });
        
    } catch (error) {
        console.error('Errore login:', error.message);
        res.status(500).json({ success: false, message: 'Errore server' });
    }
});

// ============================================
// API ME
// ============================================
app.get('/api/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// ============================================
// API MACCHINE
// ============================================
app.get('/api/machines', authenticateToken, async (req, res) => {
    try {
        let baseQuery = `
            SELECT 
                m.id, 
                m.machine_name, 
                m.mac_address, 
                m.sta_ip, 
                m.last_seen, 
                m.firmware_version, 
                m.status,
                m.water_ok,
                m.insecticide_ok,
                m.flow,
                c.name as client_name
            FROM machines m
            LEFT JOIN clients c ON m.client_id = c.id
        `;
        let whereClause = '';
        let params = [];
        
        if (req.user.role === 'installer') {
            whereClause = 'WHERE m.installer_id = $1';
            params.push(req.user.id);
        } else if (req.user.role === 'client') {
            whereClause = 'WHERE m.client_id = $1';
            params.push(req.user.client_id);
        }
        
        const orderBy = `ORDER BY m.status DESC, m.last_seen DESC NULLS LAST`;
        
        const result = await queryWithRetry(`${baseQuery} ${whereClause} ${orderBy}`, params);
        
        res.json({ success: true, machines: result.rows });
        
    } catch (error) {
        console.error('Errore GET machines:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento' });
    }
});

// ============================================
// API ALLARMI ATTIVI
// ============================================
app.get('/api/alerts', authenticateToken, async (req, res) => {
    try {
        let baseQuery = `
            SELECT a.*, m.machine_name, c.name as client_name
            FROM alerts a
            JOIN machines m ON a.machine_id = m.id
            LEFT JOIN clients c ON m.client_id = c.id
            WHERE a.status = 'active'
        `;
        let params = [];
        let paramIndex = 1;
        
        if (req.user.role === 'installer') {
            baseQuery += ` AND m.installer_id = $${paramIndex++}`;
            params.push(req.user.id);
        } else if (req.user.role === 'client') {
            baseQuery += ` AND m.client_id = $${paramIndex++}`;
            params.push(req.user.client_id);
        }
        
        baseQuery += ` ORDER BY a.created_at DESC`;
        
        const result = await queryWithRetry(baseQuery, params);
        res.json({ success: true, alerts: result.rows });
        
    } catch (error) {
        console.error('Errore GET alerts:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento allarmi' });
    }
});

// ============================================
// API RISOLVI ALLARME
// ============================================
app.post('/api/alerts/:id/resolve', authenticateToken, async (req, res) => {
    const { id } = req.params;
    
    try {
        await queryWithRetry(
            `UPDATE alerts SET status = 'resolved', resolved_at = NOW()
             WHERE id = $1`,
            [id]
        );
        res.json({ success: true, message: 'Allarme risolto' });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API DETTAGLIO MACCHINA
// ============================================
app.get('/api/machine/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    
    try {
        const result = await queryWithRetry(`
            SELECT m.*, c.name as client_name, c.email, c.phone, c.address
            FROM machines m
            LEFT JOIN clients c ON m.client_id = c.id
            WHERE m.id = $1
        `, [id]);
        
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        
        res.json({ success: true, machine: result.rows[0] });
        
    } catch (error) {
        console.error('Errore GET machine:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento' });
    }
});

// ============================================
// API CLIENTI (solo admin)
// ============================================
app.get('/api/clients', authenticateToken, requireAdmin, async (req, res) => {
    try {
        const result = await queryWithRetry('SELECT * FROM clients ORDER BY name');
        res.json({ success: true, clients: result.rows });
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

app.post('/api/clients', authenticateToken, requireAdmin, async (req, res) => {
    const { name, email, phone, address, telegram_chat_id } = req.body;
    try {
        const result = await queryWithRetry(
            `INSERT INTO clients (name, email, phone, address, telegram_chat_id) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
            [name, email, phone, address, telegram_chat_id || null]
        );
        res.json({ success: true, client: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ============================================
// API UTENTI (solo admin)
// ============================================
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

// ============================================
// API ASSEGNAZIONE MACCHINA (solo admin)
// ============================================
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

// ============================================
// API REGISTRAZIONE ESP32
// ============================================
app.post('/api/register', async (req, res) => {
    const { mac_address, ip, version, machine_name } = req.body;
    
    if (!mac_address || !ip) {
        return res.status(400).json({ success: false, message: 'Dati mancanti' });
    }
    
    const macRegex = /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i;
    if (!macRegex.test(mac_address)) {
        return res.status(400).json({ success: false, message: 'MAC address non valido' });
    }
    
    try {
        await queryWithRetry(
            `INSERT INTO machines (mac_address, sta_ip, firmware_version, machine_name, status, last_seen)
             VALUES ($1, $2, $3, $4, 'online', NOW())
             ON CONFLICT (mac_address) DO UPDATE SET 
             sta_ip = EXCLUDED.sta_ip, 
             machine_name = COALESCE(EXCLUDED.machine_name, machines.machine_name),
             firmware_version = EXCLUDED.firmware_version,
             last_seen = NOW(), 
             status = 'online'`,
            [mac_address.toUpperCase(), ip, version || '1.0', machine_name || 'NabulAir-Generic']
        );
        
        console.log(`📡 ESP32 registrato: ${mac_address}`);
        res.json({ success: true, message: 'Registrato con successo' });
        
    } catch (error) {
        console.error('ERRORE CRITICO DATABASE:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API PING ESP32
// ============================================
app.post('/api/ping', async (req, res) => {
    const { mac_address, ip, water_ok, insecticide_ok, flow, status } = req.body;
    
    if (!mac_address) {
        return res.status(400).json({ success: false });
    }
    
    try {
        await queryWithRetry(
            `UPDATE machines 
             SET last_seen = NOW(), 
                 sta_ip = COALESCE($1, sta_ip), 
                 status = $2,
                 water_ok = COALESCE($3, water_ok),
                 insecticide_ok = COALESCE($4, insecticide_ok),
                 flow = COALESCE($5, flow)
             WHERE mac_address = $6`,
            [ip, status || 'online', water_ok, insecticide_ok, flow, mac_address]
        );
        
        const machineResult = await queryWithRetry(
            'SELECT id, machine_name, client_id FROM machines WHERE mac_address = $1',
            [mac_address]
        );
        
        const machine = machineResult.rows[0];
        const machine_id = machine?.id;
        
        if (machine_id) {
            let clientInfo = null;
            if (machine.client_id) {
                const clientResult = await queryWithRetry(
                    'SELECT telegram_chat_id, name FROM clients WHERE id = $1',
                    [machine.client_id]
                );
                clientInfo = clientResult.rows[0];
            }
            
            if (insecticide_ok === false) {
                const existing = await queryWithRetry(
                    `SELECT id FROM alerts WHERE machine_id = $1 AND type = 'insecticide' AND status = 'active'`,
                    [machine_id]
                );
                if (existing.rows.length === 0) {
                    await queryWithRetry(
                        `INSERT INTO alerts (machine_id, type, message)
                         VALUES ($1, 'insecticide', '⚠️ Insetticida esaurito - Verificare il contenitore')`,
                        [machine_id]
                    );
                    console.log(`🚨 Allarme: Insetticida esaurito su macchina ${machine_id}`);
                    
                    if (clientInfo?.telegram_chat_id) {
                        await sendTelegramMessage(clientInfo.telegram_chat_id,
                            `🚨 <b>Allarme NabulAir</b>\n\n` +
                            `🏭 Macchina: <b>${machine.machine_name || mac_address}</b>\n` +
                            `⚠️ Insetticida esaurito\n` +
                            `Verificare il contenitore e rabboccare.`
                        );
                    }
                }
            } else if (insecticide_ok === true) {
                await queryWithRetry(
                    `UPDATE alerts 
                     SET status = 'resolved', resolved_at = NOW()
                     WHERE machine_id = $1 AND type = 'insecticide' AND status = 'active'`,
                    [machine_id]
                );
            }
            
            if (water_ok === false) {
                const existing = await queryWithRetry(
                    `SELECT id FROM alerts WHERE machine_id = $1 AND type = 'water' AND status = 'active'`,
                    [machine_id]
                );
                if (existing.rows.length === 0) {
                    await queryWithRetry(
                        `INSERT INTO alerts (machine_id, type, message)
                         VALUES ($1, 'water', '⚠️ Flusso acqua assente - Verificare la pressione')`,
                        [machine_id]
                    );
                    console.log(`🚨 Allarme: Acqua assente su macchina ${machine_id}`);
                    
                    if (clientInfo?.telegram_chat_id) {
                        await sendTelegramMessage(clientInfo.telegram_chat_id,
                            `🚨 <b>Allarme NabulAir</b>\n\n` +
                            `🏭 Macchina: <b>${machine.machine_name || mac_address}</b>\n` +
                            `💧 Flusso acqua assente\n` +
                            `Verificare la pressione dell'acqua.`
                        );
                    }
                }
            } else if (water_ok === true) {
                await queryWithRetry(
                    `UPDATE alerts 
                     SET status = 'resolved', resolved_at = NOW()
                     WHERE machine_id = $1 AND type = 'water' AND status = 'active'`,
                    [machine_id]
                );
            }
        }
        
        res.json({ success: true });
        
    } catch (error) {
        console.error('Errore ping:', error.message);
        res.json({ success: false });
    }
});

// ============================================
// HEALTH CHECK
// ============================================
app.get('/health', async (req, res) => {
    let dbConnected = false;
    let dbError = null;
    
    try {
        await pool.query('SELECT 1');
        dbConnected = true;
    } catch (error) {
        dbError = error.message;
    }
    
    res.json({ 
        status: dbConnected ? 'healthy' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        database: {
            connected: dbConnected,
            error: dbError
        }
    });
});

// ============================================
// ROOT ENDPOINT
// ============================================
app.get('/', (req, res) => {
    res.json({ 
        message: 'NabulAir Cloud API', 
        version: '2.5',
        status: 'online',
        features: ['Auth', 'Multi-role', 'Telegram Alerts', 'Admin Panel', 'DB Auto-Retry', 'Auto-Reconnect'],
        endpoints: [
            'GET /',
            'GET /health',
            'GET /dashboard',
            'GET /remote',
            'POST /api/setup',
            'POST /api/login',
            'GET /api/me',
            'GET /api/machines (protected)',
            'GET /api/alerts (protected)',
            'GET /api/clients (admin)',
            'POST /api/users (admin)',
            'PUT /api/machines/:id/assign (admin)',
            'POST /api/register',
            'POST /api/ping'
        ]
    });
});

// EMERGENZA: Reset password admin
app.post('/api/reset', async (req, res) => {
    const hash = await bcrypt.hash(req.body.password || 'admin', 10);
    await queryWithRetry("UPDATE users SET password_hash = $1 WHERE username = 'admin'", [hash]);
    res.json({success: true, message: 'Password resettata. Rimuovi questo endpoint!'});
});

// ============================================
// AVVIO SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`✅ NabulAir Cloud avviato su porta ${PORT}`);
    console.log(`🔐 JWT_SECRET: ${JWT_SECRET ? '✅ Configurato' : '❌ MANCANTE'}`);
    console.log(`🗄️ Database: ${DATABASE_URL ? '✅ Configurato' : '❌ MANCANTE'}`);
    console.log(`🔒 SSL DB: ${process.env.DATABASE_URL?.includes('sslmode') ? 'Configurato' : 'Default'}`);
    console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Configurato' : '❌ DISABILITATO'}`);
    console.log(`📁 File statici: ${__dirname}`);
    console.log(`🚨 Sistema allarmi: ATTIVO`);
    console.log(`🔄 DB Auto-Retry: ATTIVO (max 3 tentativi)`);
    console.log(`🔄 Auto-Reconnect: ATTIVO`);
});
