const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
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
// DATABASE CONNECTION - CONFIGURAZIONE SENZA SSL PER RAILWAY
// ============================================
// Rimuovi ?sslmode=require dalla connection string se presente
let cleanDatabaseUrl = DATABASE_URL;
if (cleanDatabaseUrl.includes('?sslmode=require')) {
    cleanDatabaseUrl = cleanDatabaseUrl.replace('?sslmode=require', '');
    console.log('⚠️ Rimosso ?sslmode=require dalla connection string');
}
if (cleanDatabaseUrl.includes('?sslmode=no-verify')) {
    cleanDatabaseUrl = cleanDatabaseUrl.replace('?sslmode=no-verify', '');
    console.log('⚠️ Rimosso ?sslmode=no-verify dalla connection string');
}

const pool = new Pool({
    connectionString: cleanDatabaseUrl,
    // Disabilita completamente SSL per connessioni interne Railway
    ssl: false,
    // Configurazione del pool per gestire le disconnessioni
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
});

// Gestione errori del pool
pool.on('error', (err) => {
    console.error('❌ Errore inaspettato nel pool PostgreSQL:', err.message);
});

// ============================================
// FUNZIONE PER VERIFICARE E RIPRISTINARE CONNESSIONE DB
// ============================================
async function ensureDbConnection() {
    try {
        await pool.query('SELECT 1');
        console.log('✅ Database connesso e attivo');
        return true;
    } catch (error) {
        console.error('❌ Database disconnesso, tentativo di riconnessione...', error.message);
        return false;
    }
}

// ============================================
// QUERY CON RETRY AUTOMATICO
// ============================================
async function queryWithRetry(query, params, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await pool.query(query, params);
        } catch (error) {
            console.error(`Tentativo ${i + 1} fallito:`, error.message);
            
            if (i === maxRetries - 1) throw error;
            
            // Attendi prima di riprovare (backoff esponenziale)
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
    }
}

// ============================================
// INIZIALIZZA DATABASE (Tabelle e trigger)
// ============================================
async function initDatabase() {
    try {
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
        `).catch(e => console.log('Colonne machines già esistenti'));

        // Aggiungi telegram_chat_id a clients
        await pool.query(`
            ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50);
        `).catch(e => console.log('Colonna telegram_chat_id già esistente'));

        // Aggiungi client_id a users per collegare utente cliente al record cliente
        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
        `).catch(e => console.log('Colonna client_id su users già esistente'));

        // Aggiungi installer_id a machines per assegnare l'installatore
        await pool.query(`
            ALTER TABLE machines ADD COLUMN IF NOT EXISTS installer_id INTEGER REFERENCES users(id);
        `).catch(e => console.log('Colonna installer_id su machines già esistente'));
        
        console.log('✅ Database inizializzato correttamente');
    } catch (err) {
        console.error('❌ Errore init database:', err.message);
    }
}

// Connessione iniziale
pool.connect(async (err) => {
    if (err) {
        console.error('❌ Errore DB iniziale:', err.message);
        console.log('⚠️ Nuovo tentativo di connessione tra 5 secondi...');
        setTimeout(async () => {
            try {
                await pool.connect();
                console.log('✅ Connesso a PostgreSQL su Railway!');
                await initDatabase();
            } catch (retryErr) {
                console.error('❌ Fallita riconnessione:', retryErr.message);
            }
        }, 5000);
    } else {
        console.log('✅ Connesso a PostgreSQL su Railway!');
        await initDatabase();
    }
});

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
// TELEGRAM WEBHOOK — riceve i messaggi dal bot
// ============================================
app.post('/api/telegram/webhook', async (req, res) => {
    res.sendStatus(200); // Risponde subito a Telegram

    try {
        const update = req.body;
        const message = update?.message;
        if (!message) return;

        const chatId = String(message.chat.id);
        const text = message.text || '';
        const firstName = message.chat.first_name || '';

        // Comando /start con payload macchina: /start machine_123
        if (text.startsWith('/start machine_')) {
            const machineId = parseInt(text.replace('/start machine_', '').trim());

            if (!machineId) {
                await sendTelegramMessage(chatId, '❌ Link non valido. Chiedi un nuovo QR al tuo installatore.');
                return;
            }

            // Trova la macchina e aggiorna il client con questo chat_id
            const machineResult = await queryWithRetry(
                'SELECT id, machine_name, client_id FROM machines WHERE id = $1',
                [machineId]
            );

            if (machineResult.rows.length === 0) {
                await sendTelegramMessage(chatId, '❌ Macchina non trovata. Contatta il tuo installatore.');
                return;
            }

            const machine = machineResult.rows[0];

            if (!machine.client_id) {
                await sendTelegramMessage(chatId,
                    `⚠️ La macchina <b>${machine.machine_name || 'NabulAir'}</b> non è ancora associata a un cliente.\n\n` +
                    `Contatta il tuo installatore per completare la configurazione.\n\n` +
                    `📋 Il tuo Chat ID è: <code>${chatId}</code>`
                );
                return;
            }

            // Salva il telegram_chat_id sul cliente
            await queryWithRetry(
                'UPDATE clients SET telegram_chat_id = $1 WHERE id = $2',
                [chatId, machine.client_id]
            );

            await sendTelegramMessage(chatId,
                `✅ <b>Attivazione completata!</b>\n\n` +
                `Ciao ${firstName}! 👋\n` +
                `Riceverai notifiche per la macchina:\n` +
                `🏭 <b>${machine.machine_name || 'NabulAir'}</b>\n\n` +
                `Ti avviseremo in caso di:\n` +
                `💧 Problemi con il flusso acqua\n` +
                `🧪 Insetticida esaurito\n\n` +
                `📋 Il tuo Chat ID: <code>${chatId}</code>`
            );

            console.log(`✅ Cliente ID ${machine.client_id} attivato su Telegram: ${chatId}`);

        } else if (text === '/start') {
            // /start senza payload — risponde con le istruzioni
            await sendTelegramMessage(chatId,
                `👋 Benvenuto su <b>NabulAir</b>!\n\n` +
                `Per attivare le notifiche, scansiona il QR Code che ti ha fornito il tuo installatore.\n\n` +
                `📋 Il tuo Chat ID è: <code>${chatId}</code>`
            );

        } else if (text === '/chatid') {
            // Comando utile per scoprire il proprio chat id manualmente
            await sendTelegramMessage(chatId,
                `📋 Il tuo Chat ID è:\n<code>${chatId}</code>\n\nComunicalo al tuo installatore.`
            );
        }

    } catch (err) {
        console.error('Errore webhook Telegram:', err.message);
    }
});

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

// Registra il webhook su Telegram (chiamare una volta sola dopo il deploy)
app.post('/api/telegram/setup-webhook', authenticateToken, requireAdmin, async (req, res) => {
    const { webhook_url } = req.body;
    if (!webhook_url) {
        return res.status(400).json({ success: false, message: 'webhook_url obbligatorio' });
    }
    if (!TELEGRAM_BOT_TOKEN) {
        return res.status(500).json({ success: false, message: 'TELEGRAM_BOT_TOKEN non configurato' });
    }
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: webhook_url })
        });
        const data = await r.json();
        res.json({ success: data.ok, telegram_response: data });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================
// API SETUP (primo avvio — crea admin)
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
// API ME (utente corrente)
// ============================================
app.get('/api/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// ============================================
// API MACCHINE (protetta + filtrata per ruolo)
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
                m.client_id,
                m.installer_id,
                c.name as client_name,
                c.telegram_chat_id
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
// API ALLARMI ATTIVI (protetta + filtrata)
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
        // Costruisce la query aggiornando solo i campi presenti nella richiesta
        const fields = [];
        const values = [];
        let idx = 1;
        if (telegram_chat_id !== undefined) { fields.push(`telegram_chat_id = $${idx++}`); values.push(telegram_chat_id || null); }
        if (name !== undefined)             { fields.push(`name = $${idx++}`);             values.push(name); }
        if (email !== undefined)            { fields.push(`email = $${idx++}`);            values.push(email); }
        if (phone !== undefined)            { fields.push(`phone = $${idx++}`);            values.push(phone); }
        if (address !== undefined)          { fields.push(`address = $${idx++}`);          values.push(address); }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, message: 'Nessun campo da aggiornare' });
        }
        values.push(id);
        await queryWithRetry(
            `UPDATE clients SET ${fields.join(', ')} WHERE id = $${idx}`,
            values
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
// API QR CODE TELEGRAM (installatore o admin)
// ============================================
app.post('/api/machines/:id/qr', authenticateToken, async (req, res) => {
    const { id } = req.params;

    // Solo installer e admin possono generare QR
    if (req.user.role !== 'admin' && req.user.role !== 'installer') {
        return res.status(403).json({ success: false, message: 'Accesso negato' });
    }

    try {
        const result = await queryWithRetry(
            'SELECT id, machine_name, mac_address FROM machines WHERE id = $1',
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }

        const machine = result.rows[0];

        if (!TELEGRAM_BOT_TOKEN) {
            return res.status(500).json({ success: false, message: 'Bot Telegram non configurato' });
        }

        // Ricava il nome del bot dal token
        let botUsername = 'NabulAirBot';
        try {
            const botRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
            const botData = await botRes.json();
            if (botData.ok) botUsername = botData.result.username;
        } catch (e) {
            console.warn('Impossibile recuperare username bot:', e.message);
        }

        // Il payload include l'ID macchina (start parameter)
        const startPayload = `machine_${machine.id}`;
        const telegramLink = `https://t.me/${botUsername}?start=${startPayload}`;

        res.json({
            success: true,
            telegram_link: telegramLink,
            machine_name: machine.machine_name || machine.mac_address
        });

    } catch (error) {
        console.error('Errore generazione QR:', error.message);
        res.status(500).json({ success: false, message: 'Errore generazione QR: ' + error.message });
    }
});

// ============================================
// API DEBUG — legge ultimi messaggi bot (trova Chat ID)
// ============================================
app.get('/api/telegram/last-messages', async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) {
        return res.status(500).json({ success: false, message: 'TELEGRAM_BOT_TOKEN non configurato' });
    }
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?limit=10`);
        const data = await r.json();
        if (!data.ok) {
            return res.json({ success: false, message: data.description });
        }
        const messages = data.result.map(u => ({
            chat_id: u.message?.chat?.id,
            name: u.message?.chat?.first_name + ' ' + (u.message?.chat?.last_name || ''),
            username: u.message?.chat?.username,
            text: u.message?.text,
            date: u.message?.date ? new Date(u.message.date * 1000).toLocaleString('it-IT') : null
        })).filter(m => m.chat_id);
        res.json({ success: true, messages });
    } catch (err) {
        res.status(500).json({ success: false, message: err.message });
    }
});

// ============================================
// API REGISTRAZIONE ESP32 (pubblica) - CON RETRY
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
        
        console.log(`📡 ESP32 registrato con successo: ${mac_address}`);
        res.json({ success: true, message: 'Registrato con successo' });
        
    } catch (error) {
        console.error('ERRORE CRITICO DATABASE:', error.message);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ============================================
// API PING ESP32 (con stato allarmi + Telegram)
// ============================================
app.post('/api/ping', async (req, res) => {
    const { mac_address, ip, water_ok, insecticide_ok, flow, status } = req.body;
    
    if (!mac_address) {
        return res.status(400).json({ success: false });
    }
    
    try {
        // Aggiorna macchina con i nuovi stati
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
        
        // Ottieni machine_id e dati cliente
        const machineResult = await queryWithRetry(
            'SELECT id, machine_name, client_id FROM machines WHERE mac_address = $1',
            [mac_address]
        );
        
        const machine = machineResult.rows[0];
        const machine_id = machine?.id;
        
        if (machine_id) {
            // Recupera dati cliente per Telegram
            let clientInfo = null;
            if (machine.client_id) {
                const clientResult = await queryWithRetry(
                    'SELECT telegram_chat_id, name FROM clients WHERE id = $1',
                    [machine.client_id]
                );
                clientInfo = clientResult.rows[0];
            }
            
            // Gestione allarme insetticida
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
            
            // Gestione allarme acqua
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
// HEALTH CHECK MIGLIORATO
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
        ssl: false,
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
        version: '2.4',
        status: 'online',
        ssl_db: false,
        features: ['Auth', 'Multi-role', 'Telegram Alerts', 'Admin Panel', 'DB Auto-Retry'],
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

// EMERGENZA: Reset password admin. RIMUOVI DOPO AVER ENTRATO!
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
    console.log(`🔒 SSL DB: DISABILITATO (per Railway internal network)`);
    console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Configurato' : '❌ DISABILITATO'}`);
    console.log(`📁 File statici: ${__dirname}`);
    console.log(`🚨 Sistema allarmi: ATTIVO`);
    console.log(`🔄 DB Auto-Retry: ATTIVO (max 3 tentativi)`);
});
