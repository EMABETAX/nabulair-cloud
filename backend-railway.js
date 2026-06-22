const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const path = require('path');
const { Resend } = require('resend');
const webpush = require('web-push');
const multer = require('multer');

// VAPID keys — genera con: npx web-push generate-vapid-keys
// Metti in variabili d'ambiente Railway
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    webpush.setVapidDetails(
        `mailto:${process.env.VAPID_EMAIL || 'admin@nabulair.it'}`,
        process.env.VAPID_PUBLIC_KEY,
        process.env.VAPID_PRIVATE_KEY
    );
    console.log('🔔 Web Push VAPID configurato');
} else {
    console.log('⚠️ Web Push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY non configurati');
}

const resend = process.env.RESEND_API_KEY
    ? new Resend(process.env.RESEND_API_KEY)
    : null;
const EMAIL_FROM = process.env.EMAIL_FROM || 'NabulAir <noreply@nabulair.it>';
const APP_URL    = process.env.APP_URL    || 'https://nabulair-cloud-production.up.railway.app';

const app = express();
const PORT = process.env.PORT || 3000;

const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',')
    : ['https://nabulair-cloud-production.up.railway.app', 'http://localhost:3000'];

app.use(cors({
    origin: ALLOWED_ORIGINS,
    credentials: true
}));
app.use(express.json());

// File statici
app.use(express.static(__dirname));

app.get('/dashboard', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});

app.get('/remote', (req, res) => {
    res.sendFile(path.join(__dirname, 'remote.html'));
});

app.get('/remote.html', (req, res) => {
    res.sendFile(path.join(__dirname, 'remote.html'));
});

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
    ssl: false,
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10000
});

pool.on('error', (err) => {
    console.error('❌ Errore inaspettato nel pool PostgreSQL:', err.message);
});

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

async function queryWithRetry(query, params, maxRetries = 3) {
    for (let i = 0; i < maxRetries; i++) {
        try {
            return await pool.query(query, params);
        } catch (error) {
            console.error(`Tentativo ${i + 1} fallito:`, error.message);
            if (i === maxRetries - 1) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * Math.pow(2, i)));
        }
    }
}

async function initDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS machines (
                id SERIAL PRIMARY KEY,
                mac_address VARCHAR(17) UNIQUE NOT NULL,
                machine_name VARCHAR(100),
                sta_ip VARCHAR(15),
                firmware_version VARCHAR(20),
                status VARCHAR(20) DEFAULT 'pending',
                last_seen TIMESTAMP,
                water_ok BOOLEAN DEFAULT NULL,
                insecticide_ok BOOLEAN DEFAULT NULL,
                flow FLOAT DEFAULT 0,
                client_id INTEGER REFERENCES clients(id),
                installer_id INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `).catch(e => console.log('Tabella machines già esistente'));

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

        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS water_ok BOOLEAN DEFAULT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS insecticide_ok BOOLEAN DEFAULT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS flow FLOAT DEFAULT 0`).catch(() => {});

        // Posizione per il meteo (impostata dal cliente dall'app)
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS latitude FLOAT DEFAULT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS longitude FLOAT DEFAULT NULL`).catch(() => {});
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS location_name VARCHAR(120) DEFAULT NULL`).catch(() => {});

        // Firmware OTA caricati da dashboard (drag & drop)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS firmware_files (
                id SERIAL PRIMARY KEY,
                token VARCHAR(64) UNIQUE NOT NULL,
                filename VARCHAR(255) NOT NULL,
                fw_type VARCHAR(20) NOT NULL DEFAULT 'firmware',
                version VARCHAR(30),
                notes VARCHAR(255),
                size_bytes INTEGER,
                data BYTEA NOT NULL,
                uploaded_by INTEGER REFERENCES users(id),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `).catch(e => console.log('Tabella firmware_files già esistente'));

        await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS telegram_chat_id VARCHAR(50)`).catch(() => {});

        await pool.query(`
            CREATE TABLE IF NOT EXISTS password_reset_tokens (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
                token VARCHAR(64) UNIQUE NOT NULL,
                expires_at TIMESTAMP NOT NULL,
                used BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `).catch(() => {});
        await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS created_by_installer_id INTEGER REFERENCES users(id)`).catch(() => {});

        await pool.query(`
            ALTER TABLE users ADD COLUMN IF NOT EXISTS client_id INTEGER REFERENCES clients(id);
        `).catch(e => console.log('Colonna client_id su users già esistente'));

        await pool.query(`
            ALTER TABLE machines ADD COLUMN IF NOT EXISTS installer_id INTEGER REFERENCES users(id);
        `).catch(e => console.log('Colonna installer_id su machines già esistente'));

        await pool.query(`
            CREATE TABLE IF NOT EXISTS commands (
                id SERIAL PRIMARY KEY,
                machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
                type VARCHAR(50) NOT NULL,
                payload JSONB,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                executed_at TIMESTAMP NULL,
                created_by INTEGER REFERENCES users(id)
            )
        `);

        // ========== NUOVA TABELLA PER I PROGRAMMI ==========
        await pool.query(`
            CREATE TABLE IF NOT EXISTS machine_programs (
                id SERIAL PRIMARY KEY,
                machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
                programs JSONB NOT NULL DEFAULT '[]',
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(machine_id)
            )
        `);

        // Colonne per pausa globale programmi
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS paused BOOLEAN DEFAULT FALSE`).catch(() => {});
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS pause_until DATE`).catch(() => {});

        // Tabella storico cicli (v1.5)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cicli (
                id SERIAL PRIMARY KEY,
                machine_id INTEGER REFERENCES machines(id) ON DELETE CASCADE,
                started_at TIMESTAMP NOT NULL DEFAULT NOW(),
                duration_sec INTEGER NOT NULL DEFAULT 0,
                product VARCHAR(20) DEFAULT 'insecticide',
                ml_consumed FLOAT DEFAULT 0,
                zona INTEGER DEFAULT 1,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `).catch(() => {});

        // Web push subscriptions (v1.5)
        await pool.query(`ALTER TABLE clients ADD COLUMN IF NOT EXISTS push_subscription JSONB`).catch(() => {});

        // ========== AGGIUNTA COLONNE PER TRACKING SYNC ==========
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_ntp_sync TIMESTAMP`).catch(() => {});
        await pool.query(`ALTER TABLE machines ADD COLUMN IF NOT EXISTS last_prog_sync TIMESTAMP`).catch(() => {});

        // MIGRATION RIMOSSA: non azzerare water_ok/insecticide_ok
        // I valori vengono aggiornati solo dal ping dell'ESP32
        console.log('✅ Database inizializzato correttamente (migration sensori disabilitata)');

    } catch (err) {
        console.error('❌ Errore init database:', err.message);
    }
}

(async () => {
    try {
        await pool.query('SELECT 1');
        console.log('✅ Connesso a PostgreSQL su Railway!');
        await initDatabase();
    } catch (err) {
        console.error('❌ Errore DB iniziale:', err.message);
        console.log('⚠️ Nuovo tentativo di connessione tra 5 secondi...');
        setTimeout(async () => {
            try {
                await pool.query('SELECT 1');
                console.log('✅ Connesso a PostgreSQL su Railway! (retry)');
                await initDatabase();
            } catch (retryErr) {
                console.error('❌ Fallita riconnessione:', retryErr.message);
            }
        }, 5000);
    }
})();

function startOfflineDetectionJob() {
    const OFFLINE_THRESHOLD_MINUTES = 5;
    const CHECK_INTERVAL_MS = 60 * 1000;

    setInterval(async () => {
        try {
            const result = await pool.query(
                `UPDATE machines 
                 SET status = 'offline' 
                 WHERE status != 'offline' 
                   AND last_seen < NOW() - INTERVAL '${OFFLINE_THRESHOLD_MINUTES} minutes'`
            );
            if (result.rowCount > 0) {
                console.log(`🔴 ${result.rowCount} macchina/e marcate offline (no ping da >${OFFLINE_THRESHOLD_MINUTES}min)`);
            }
        } catch (err) {
            console.error('❌ Errore nel job offline detection:', err.message);
        }
    }, CHECK_INTERVAL_MS);

    console.log(`🕐 Offline detection job attivo: check ogni ${CHECK_INTERVAL_MS/1000}s, timeout ${OFFLINE_THRESHOLD_MINUTES}min`);
}

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

// ─────────────────────────────────────────────
// WEB PUSH HELPER
// ─────────────────────────────────────────────
async function sendPushNotification(clientId, title, body, url = '/remote.html') {
    if (!process.env.VAPID_PUBLIC_KEY) return;
    try {
        const result = await pool.query(
            'SELECT push_subscription FROM clients WHERE id = $1',
            [clientId]
        );
        if (!result.rows.length || !result.rows[0].push_subscription) return;

        const subscription = result.rows[0].push_subscription;
        const payload = JSON.stringify({ title, body, url, icon: '/logo.png' });

        await webpush.sendNotification(subscription, payload);
        console.log(`🔔 Push inviata a client ${clientId}: ${title}`);
    } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
            // Subscription scaduta — rimuovi
            await pool.query('UPDATE clients SET push_subscription = NULL WHERE id = $1', [clientId]).catch(() => {});
            console.log(`🔔 Push subscription rimossa per client ${clientId} (scaduta)`);
        } else {
            console.error('Errore push:', err.message);
        }
    }
}

app.post('/api/telegram/webhook', async (req, res) => {
    res.sendStatus(200);

    try {
        const update = req.body;
        const message = update?.message;
        if (!message) return;

        const chatId = String(message.chat.id);
        const text = message.text || '';
        const firstName = message.chat.first_name || '';

        if (text.startsWith('/start machine_')) {
            const machineId = parseInt(text.replace('/start machine_', '').trim());

            if (!machineId) {
                await sendTelegramMessage(chatId, '❌ Link non valido. Chiedi un nuovo QR al tuo installatore.');
                return;
            }

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
            await sendTelegramMessage(chatId,
                `👋 Benvenuto su <b>NabulAir</b>!\n\n` +
                `Per attivare le notifiche, scansiona il QR Code che ti ha fornito il tuo installatore.\n\n` +
                `📋 Il tuo Chat ID è: <code>${chatId}</code>`
            );

        } else if (text === '/chatid') {
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

function requireRole(...roles) {
    return (req, res, next) => {
        if (!roles.includes(req.user.role)) {
            return res.status(403).json({ success: false, message: 'Accesso negato: richiesto ruolo ' + roles.join(' o ') });
        }
        next();
    };
}

const requireAdmin = requireRole('admin');

app.post('/api/telegram/setup-webhook', authenticateToken, requireRole('admin', 'installer'), async (req, res) => {
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

app.get('/api/telegram/webhook-status', authenticateToken, requireRole('admin', 'installer'), async (req, res) => {
    if (!TELEGRAM_BOT_TOKEN) {
        return res.json({ success: false, url: null, message: 'TELEGRAM_BOT_TOKEN non configurato' });
    }
    try {
        const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getWebhookInfo`);
        const data = await r.json();
        res.json({
            success: data.ok,
            url: data.result?.url || null,
            pending_updates: data.result?.pending_update_count || 0
        });
    } catch (err) {
        res.status(500).json({ success: false, url: null, message: err.message });
    }
});

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

// ─────────────────────────────────────────────
// RESET PASSWORD
// ─────────────────────────────────────────────

app.post('/api/reset-request', async (req, res) => {
    const { email } = req.body;
    if (!email) return res.status(400).json({ success: false, message: 'Email obbligatoria' });
    try {
        const result = await pool.query(`
            SELECT u.id, u.username, c.email, c.name
            FROM users u
            JOIN clients c ON u.client_id = c.id
            WHERE LOWER(c.email) = LOWER($1) AND u.role = 'client'
            LIMIT 1
        `, [email.trim()]);
        if (result.rows.length === 0) {
            return res.json({ success: true, message: "Se l'email è registrata riceverai le istruzioni" });
        }
        const user = result.rows[0];
        await pool.query(`UPDATE password_reset_tokens SET used = TRUE WHERE user_id = $1 AND used = FALSE`, [user.id]);
        const token = require('crypto').randomBytes(32).toString('hex');
        const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
        await pool.query(`INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES ($1, $2, $3)`, [user.id, token, expiresAt]);
        const resetLink = `${APP_URL}/reset.html?token=${token}`;
        if (resend) {
            await resend.emails.send({
                from: EMAIL_FROM,
                to: user.email,
                subject: 'NabulAir — Reimposta la tua password',
                html: `<div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;"><h2 style="color:#10B981;">NabulAir</h2><p>Ciao ${user.name || user.username},</p><p>Hai richiesto il reset della password.</p><p style="margin:24px 0;"><a href="${resetLink}" style="background:#10B981;color:#000;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;">Reimposta password</a></p><p style="color:#666;font-size:13px;">Il link scade tra 1 ora.</p></div>`
            });
        } else {
            console.log(`[RESET] Link: ${resetLink}`);
        }
        res.json({ success: true, message: "Se l'email è registrata riceverai le istruzioni" });
    } catch (error) {
        console.error('Errore reset-request:', error.message);
        res.status(500).json({ success: false, message: 'Errore interno' });
    }
});

app.post('/api/reset-confirm', async (req, res) => {
    const { token, password } = req.body;
    if (!token || !password) return res.status(400).json({ success: false, message: 'Dati mancanti' });
    if (password.length < 6) return res.status(400).json({ success: false, message: 'Password minimo 6 caratteri' });
    try {
        const result = await pool.query(`SELECT prt.user_id, prt.id as token_id FROM password_reset_tokens prt WHERE prt.token = $1 AND prt.used = FALSE AND prt.expires_at > NOW() LIMIT 1`, [token]);
        if (result.rows.length === 0) return res.status(400).json({ success: false, message: 'Link non valido o scaduto.' });
        const { user_id, token_id } = result.rows[0];
        const hash = await bcrypt.hash(password, 10);
        await pool.query(`UPDATE users SET password_hash = $1 WHERE id = $2`, [hash, user_id]);
        await pool.query(`UPDATE password_reset_tokens SET used = TRUE WHERE id = $1`, [token_id]);
        res.json({ success: true, message: 'Password aggiornata con successo' });
    } catch (error) {
        res.status(500).json({ success: false, message: 'Errore interno' });
    }
});

app.get('/api/reset-check', async (req, res) => {
    const { token } = req.query;
    if (!token) return res.status(400).json({ valid: false });
    try {
        const result = await pool.query(`SELECT id FROM password_reset_tokens WHERE token = $1 AND used = FALSE AND expires_at > NOW()`, [token]);
        res.json({ valid: result.rows.length > 0 });
    } catch { res.json({ valid: false }); }
});

app.get('/api/me', authenticateToken, (req, res) => {
    res.json({ success: true, user: req.user });
});

// CAMBIO PASSWORD (utente autenticato)
// ─────────────────────────────────────────────

app.post('/api/change-password', authenticateToken, async (req, res) => {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword)
        return res.status(400).json({ success: false, message: 'Dati mancanti' });
    if (newPassword.length < 6)
        return res.status(400).json({ success: false, message: 'La nuova password deve essere di almeno 6 caratteri' });
    try {
        const result = await pool.query(
            'SELECT password_hash FROM users WHERE id = $1',
            [req.user.id]
        );
        if (!result.rows.length)
            return res.status(404).json({ success: false, message: 'Utente non trovato' });

        const valid = await bcrypt.compare(currentPassword, result.rows[0].password_hash);
        if (!valid)
            return res.status(401).json({ success: false, message: 'Password attuale non corretta' });

        const hash = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
        console.log(`🔑 Password aggiornata per utente ${req.user.id} (${req.user.username})`);
        res.json({ success: true, message: 'Password aggiornata con successo' });
    } catch (error) {
        console.error('Errore change-password:', error.message);
        res.status(500).json({ success: false, message: 'Errore interno' });
    }
});

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
                CASE 
                    WHEN m.last_seen <= NOW() - INTERVAL '5 minutes' THEN 'offline'
                    WHEN m.status = 'active' THEN 'active'
                    ELSE 'online' 
                END as status,
                m.water_ok,
                m.insecticide_ok,
                m.flow,
                m.client_id,
                m.installer_id,
                m.paused,
                m.pause_until,
                m.latitude,
                m.longitude,
                m.location_name,
                c.name as client_name,
                c.telegram_chat_id,
                u.username as installer_name
            FROM machines m
            LEFT JOIN clients c ON m.client_id = c.id
            LEFT JOIN users u ON m.installer_id = u.id
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

        const orderBy = `ORDER BY 
            CASE WHEN m.last_seen > NOW() - INTERVAL '5 minutes' THEN 1 ELSE 0 END DESC, 
            m.last_seen DESC NULLS LAST`;

        const result = await queryWithRetry(`${baseQuery} ${whereClause} ${orderBy}`, params);

        res.json({ success: true, machines: result.rows });

    } catch (error) {
        console.error('Errore GET machines:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento' });
    }
});

// ← FIX FLUSSO: endpoint pre-registrazione macchina (Admin vende HW all'installatore)
app.post('/api/machines/preregister', authenticateToken, requireAdmin, async (req, res) => {
    const { mac_address, installer_id, machine_name } = req.body;

    if (!mac_address) {
        return res.status(400).json({ success: false, message: 'MAC address obbligatorio' });
    }

    const macRegex = /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i;
    if (!macRegex.test(mac_address)) {
        return res.status(400).json({ success: false, message: 'MAC address non valido' });
    }

    try {
        if (installer_id) {
            const instCheck = await queryWithRetry(
                'SELECT id FROM users WHERE id = $1 AND role = $2',
                [installer_id, 'installer']
            );
            if (instCheck.rows.length === 0) {
                return res.status(400).json({ success: false, message: 'Installatore non trovato' });
            }
        }

        const result = await queryWithRetry(
            `INSERT INTO machines (mac_address, machine_name, installer_id, status, last_seen)
             VALUES ($1, $2, $3, 'pending', NULL)
             ON CONFLICT (mac_address) DO UPDATE SET 
                 installer_id = EXCLUDED.installer_id,
                 machine_name = COALESCE(EXCLUDED.machine_name, machines.machine_name)
             RETURNING *`,
            [mac_address.toUpperCase(), machine_name || null, installer_id || null]
        );

        console.log(`📦 Macchina pre-registrata: ${mac_address} → installer ${installer_id}`);
        res.json({ success: true, machine: result.rows[0] });

    } catch (error) {
        console.error('Errore pre-registrazione:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/machines/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { machine_name, mac_address } = req.body;

    try {
        const fields = [];
        const values = [];
        let idx = 1;

        if (machine_name !== undefined) { fields.push(`machine_name = $${idx++}`); values.push(machine_name); }
        if (mac_address !== undefined) { 
            const macRegex = /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i;
            if (!macRegex.test(mac_address)) {
                return res.status(400).json({ success: false, message: 'MAC address non valido' });
            }
            fields.push(`mac_address = $${idx++}`); 
            values.push(mac_address.toUpperCase()); 
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, message: 'Nessun campo da aggiornare' });
        }

        values.push(id);
        await queryWithRetry(`UPDATE machines SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        res.json({ success: true, message: 'Macchina aggiornata' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/machine/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;

    try {
        const machineId = parseInt(id);
        const ownerCheck = await queryWithRetry(
            'SELECT installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (ownerCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const owner = ownerCheck.rows[0];
        if (req.user.role === 'installer' && owner.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && owner.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        const result = await queryWithRetry(`
            SELECT 
                m.id,
                m.machine_name,
                m.mac_address,
                m.sta_ip,
                m.last_seen,
                m.firmware_version,
                m.water_ok,
                m.insecticide_ok,
                m.flow,
                m.client_id,
                m.installer_id,
                m.paused,
                m.pause_until,
                m.latitude,
                m.longitude,
                m.location_name,
                m.created_at,
                CASE 
                    WHEN m.last_seen <= NOW() - INTERVAL '5 minutes' THEN 'offline'
                    WHEN m.status = 'active' THEN 'active'
                    ELSE 'online' 
                END as status,
                c.name as client_name,
                c.email,
                c.phone,
                c.address,
                c.telegram_chat_id
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

app.delete('/api/machines/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        // Prima cancella gli allarmi e comandi associati (FK CASCADE li gestisce, ma per sicurezza)
        await queryWithRetry('DELETE FROM alerts WHERE machine_id = $1', [id]);
        await queryWithRetry('DELETE FROM commands WHERE machine_id = $1', [id]);

        const result = await queryWithRetry('DELETE FROM machines WHERE id = $1 RETURNING id', [id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        console.log(`🗑 Macchina ${id} eliminata da admin`);
        res.json({ success: true, message: 'Macchina eliminata' });
    } catch (error) {
        console.error('Errore delete machine:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

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

app.get('/api/clients', authenticateToken, async (req, res) => {
    try {
        let query = `
            SELECT c.*, u.username
            FROM clients c
            LEFT JOIN users u ON u.client_id = c.id AND u.role = 'client'
        `;
        let params = [];
        let whereConditions = [];

        if (req.user.role === 'admin') {
            // nessun filtro
        } else if (req.user.role === 'installer') {
            whereConditions.push(`(c.created_by_installer_id = $${params.length+1} OR EXISTS (SELECT 1 FROM machines m WHERE m.client_id = c.id AND m.installer_id = $${params.length+1}))`);
            params.push(req.user.id);
        } else if (req.user.role === 'client') {
            whereConditions.push(`c.id = $${params.length+1}`);
            params.push(req.user.client_id);
        } else {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        if (whereConditions.length > 0) {
            query += ' WHERE ' + whereConditions.join(' AND ');
        }
        query += ' ORDER BY c.name';

        const result = await queryWithRetry(query, params);
        res.json({ success: true, clients: result.rows });
    } catch (error) {
        console.error('Errore GET clients:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/clients', authenticateToken, requireRole('admin', 'installer'), async (req, res) => {
    const { name, email, phone, address, telegram_chat_id, password } = req.body;
    if (!name) {
        return res.status(400).json({ success: false, message: 'Il nome è obbligatorio' });
    }
    if (!password) {
        return res.status(400).json({ success: false, message: 'La password per il cliente è obbligatoria' });
    }
    if (password.length < 6) {
        return res.status(400).json({ success: false, message: 'La password deve essere di almeno 6 caratteri' });
    }

    try {
        // Normalizza username: tolowercase, rimuove spazi, caratteri speciali leggeri
        let username = name.toLowerCase()
            .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // rimuove accenti
            .replace(/[^a-z0-9_]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_|_$/, '');
        if (!username) username = `client_${Date.now()}`;

        // Verifica unicità username
        const existingUser = await queryWithRetry('SELECT id FROM users WHERE username = $1', [username]);
        if (existingUser.rows.length > 0) {
            username = `${username}_${Date.now()}`;
        }

        let created_by_installer_id = null;
        if (req.user.role === 'installer') {
            created_by_installer_id = req.user.id;
        }

        // Inserisci cliente
        const clientResult = await queryWithRetry(
            `INSERT INTO clients (name, email, phone, address, telegram_chat_id, created_by_installer_id) 
             VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [name, email || null, phone || null, address || null, telegram_chat_id || null, created_by_installer_id]
        );
        const client = clientResult.rows[0];

        // Crea utente client associato
        const hash = await bcrypt.hash(password, 10);
        await queryWithRetry(
            `INSERT INTO users (username, password_hash, role, client_id) 
             VALUES ($1, $2, 'client', $3)`,
            [username, hash, client.id]
        );

        res.json({ success: true, client: client, user_created: username });
    } catch (error) {
        console.error('Errore creazione cliente:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.get('/api/clients/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    try {
        let query = `
            SELECT c.*, u.username, u.id as user_id
            FROM clients c
            LEFT JOIN users u ON u.client_id = c.id AND u.role = 'client'
            WHERE c.id = $1
        `;
        let params = [id];

        if (req.user.role === 'installer') {
            query += ` AND (c.created_by_installer_id = $2 OR EXISTS (SELECT 1 FROM machines m WHERE m.client_id = c.id AND m.installer_id = $2))`;
            params.push(req.user.id);
        } else if (req.user.role === 'client') {
            if (req.user.client_id != id) {
                return res.status(403).json({ success: false, message: 'Accesso negato' });
            }
        } else if (req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        const result = await queryWithRetry(query, params);
        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Cliente non trovato' });
        }
        res.json({ success: true, client: result.rows[0] });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/clients/:id', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { telegram_chat_id, name, email, phone, address, password } = req.body;

    try {
        if (req.user.role === 'installer') {
            const checkResult = await queryWithRetry(
                `SELECT id FROM clients WHERE id = $1 AND created_by_installer_id = $2`,
                [id, req.user.id]
            );
            if (checkResult.rows.length === 0) {
                return res.status(403).json({ success: false, message: 'Puoi modificare solo i clienti che hai creato tu' });
            }
        } else if (req.user.role === 'client') {
            if (req.user.client_id != id) {
                return res.status(403).json({ success: false, message: 'Puoi modificare solo il tuo profilo' });
            }
        } else if (req.user.role !== 'admin') {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        const fields = [];
        const values = [];
        let idx = 1;
        if (telegram_chat_id !== undefined) { fields.push(`telegram_chat_id = $${idx++}`); values.push(telegram_chat_id || null); }
        if (name !== undefined)             { fields.push(`name = $${idx++}`);             values.push(name); }
        if (email !== undefined)            { fields.push(`email = $${idx++}`);            values.push(email); }
        if (phone !== undefined)            { fields.push(`phone = $${idx++}`);            values.push(phone); }
        if (address !== undefined)          { fields.push(`address = $${idx++}`);          values.push(address); }

        if (fields.length === 0 && !password) {
            return res.status(400).json({ success: false, message: 'Nessun campo da aggiornare' });
        }

        if (fields.length > 0) {
            values.push(id);
            await queryWithRetry(
                `UPDATE clients SET ${fields.join(', ')} WHERE id = $${idx}`,
                values
            );
        }

        // Aggiorna password utente client se fornita
        if (password) {
            if (password.length < 6) {
                return res.status(400).json({ success: false, message: 'La password deve essere di almeno 6 caratteri' });
            }
            const hash = await bcrypt.hash(password, 10);
            const userResult = await queryWithRetry(
                `SELECT id FROM users WHERE client_id = $1 AND role = 'client'`,
                [id]
            );
            if (userResult.rows.length > 0) {
                await queryWithRetry(
                    `UPDATE users SET password_hash = $1 WHERE id = $2`,
                    [hash, userResult.rows[0].id]
                );
            } else {
                // Se per qualche ragione non esiste, lo creiamo
                let username = (name || 'cliente').toLowerCase().replace(/[^a-z0-9]/g, '_');
                const hash = await bcrypt.hash(password, 10);
                await queryWithRetry(
                    `INSERT INTO users (username, password_hash, role, client_id) VALUES ($1, $2, 'client', $3)`,
                    [username, hash, id]
                );
            }
        }

        res.json({ success: true, message: 'Cliente aggiornato' });
    } catch (error) {
        console.error('Errore update cliente:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.delete('/api/clients/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    try {
        const checkResult = await queryWithRetry(
            'SELECT id FROM machines WHERE client_id = $1 LIMIT 1',
            [id]
        );
        if (checkResult.rows.length > 0) {
            return res.status(400).json({ 
                success: false, 
                message: 'Impossibile eliminare: cliente associato a uno o più impianti' 
            });
        }

        // Elimina l'utente client associato
        await queryWithRetry('DELETE FROM users WHERE client_id = $1 AND role = $2', [id, 'client']);
        // Elimina il cliente
        await queryWithRetry('DELETE FROM clients WHERE id = $1', [id]);
        res.json({ success: true, message: 'Cliente eliminato' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

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

app.delete('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const userId = parseInt(id);

    try {
        // Non permettere di cancellare se stesso
        if (userId === req.user.id) {
            return res.status(400).json({ success: false, message: 'Non puoi eliminare il tuo account' });
        }

        // Verifica che non sia un admin (opzionale: puoi bloccare cancellazione admin)
        const userCheck = await queryWithRetry('SELECT role FROM users WHERE id = $1', [userId]);
        if (userCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Utente non trovato' });
        }

        // Se è un installatore, verifica che non abbia macchine assegnate
        if (userCheck.rows[0].role === 'installer') {
            const machines = await queryWithRetry('SELECT id FROM machines WHERE installer_id = $1 LIMIT 1', [userId]);
            if (machines.rows.length > 0) {
                return res.status(400).json({ 
                    success: false, 
                    message: 'Impossibile eliminare: installatore ha macchine assegnate. Riassegna o elimina le macchine prima.' 
                });
            }
        }

        await queryWithRetry('DELETE FROM users WHERE id = $1', [userId]);
        console.log(`🗑 Utente ${userId} eliminato da admin`);
        res.json({ success: true, message: 'Utente eliminato' });
    } catch (error) {
        console.error('Errore delete user:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/users/:id', authenticateToken, requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { username, password, role, client_id } = req.body;

    try {
        const fields = [];
        const values = [];
        let idx = 1;

        if (username !== undefined) { fields.push(`username = $${idx++}`); values.push(username.toLowerCase()); }
        if (role !== undefined)     { fields.push(`role = $${idx++}`);     values.push(role); }
        if (client_id !== undefined){ fields.push(`client_id = $${idx++}`);values.push(client_id || null); }

        if (password) {
            const hash = await bcrypt.hash(password, 10);
            fields.push(`password_hash = $${idx++}`);
            values.push(hash);
        }

        if (fields.length === 0) {
            return res.status(400).json({ success: false, message: 'Nessun campo da aggiornare' });
        }

        values.push(id);
        await queryWithRetry(`UPDATE users SET ${fields.join(', ')} WHERE id = $${idx}`, values);
        res.json({ success: true, message: 'Utente aggiornato' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/machines/:id/assign', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { client_id, installer_id } = req.body;

    try {
        const machineCheck = await queryWithRetry(
            'SELECT installer_id FROM machines WHERE id = $1',
            [id]
        );

        if (machineCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }

        if (req.user.role === 'installer') {
            if (machineCheck.rows[0].installer_id !== req.user.id) {
                return res.status(403).json({ success: false, message: 'Puoi assegnare solo i tuoi impianti' });
            }
            await queryWithRetry(
                'UPDATE machines SET client_id = $1 WHERE id = $2',
                [client_id || null, id]
            );
        } else if (req.user.role === 'admin') {
            await queryWithRetry(
                'UPDATE machines SET client_id = $1, installer_id = $2 WHERE id = $3',
                [client_id || null, installer_id || null, id]
            );
        } else {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        res.json({ success: true, message: 'Macchina aggiornata' });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/machines/:id/qr', authenticateToken, async (req, res) => {
    const { id } = req.params;

    if (req.user.role !== 'admin' && req.user.role !== 'installer') {
        return res.status(403).json({ success: false, message: 'Accesso negato' });
    }

    try {
        let machineQuery = 'SELECT id, machine_name, mac_address, installer_id FROM machines WHERE id = $1';
        let params = [id];

        const result = await queryWithRetry(machineQuery, params);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }

        const machine = result.rows[0];

        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Non hai accesso a questa macchina' });
        }

        if (!TELEGRAM_BOT_TOKEN) {
            return res.status(500).json({ success: false, message: 'Bot Telegram non configurato' });
        }

        let botUsername = 'NabulAirBot';
        try {
            const botRes = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getMe`);
            const botData = await botRes.json();
            if (botData.ok) botUsername = botData.result.username;
        } catch (e) {
            console.warn('Impossibile recuperare username bot:', e.message);
        }

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

app.post('/api/ping', async (req, res) => {
    const { mac_address, ip, water_ok, insecticide_ok, flow, status } = req.body;

    if (!mac_address) {
        return res.status(400).json({ success: false });
    }

    // Normalizza MAC in uppercase per coerenza con la pre-registrazione
    const normalizedMac = mac_address.toUpperCase();

    try {
        // Aggiorna anche i timestamp di sync se forniti
        await queryWithRetry(
            `UPDATE machines 
             SET last_seen = NOW(), 
                 sta_ip = COALESCE($1, sta_ip), 
                 status = $2,
                 water_ok = CASE WHEN $3::boolean IS NOT NULL THEN $3::boolean ELSE water_ok END,
                 insecticide_ok = CASE WHEN $4::boolean IS NOT NULL THEN $4::boolean ELSE insecticide_ok END,
                 flow = COALESCE($5, flow)
             WHERE mac_address = $6`,
            [ip || null, status || 'online', 
             water_ok !== undefined ? water_ok : null,
             insecticide_ok !== undefined ? insecticide_ok : null,
             flow !== undefined ? flow : null,
             normalizedMac]
        );

        const machineResult = await queryWithRetry(
            'SELECT id, machine_name, client_id, paused, pause_until, last_ntp_sync, last_prog_sync FROM machines WHERE mac_address = $1',
            [normalizedMac]
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
                            `🏭 Macchina: <b>${machine.machine_name || normalizedMac}</b>\n` +
                            `⚠️ Insetticida esaurito\n` +
                            `Verificare il contenitore e rabboccare.`
                        );
                    }
                    // Web push (v1.5)
                    if (machine.client_id) {
                        await sendPushNotification(machine.client_id,
                            '⚠️ NabulAir — Insetticida esaurito',
                            `${machine.machine_name || 'Impianto'}: verificare il contenitore.`
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
                            `🏭 Macchina: <b>${machine.machine_name || normalizedMac}</b>\n` +
                            `💧 Flusso acqua assente\n` +
                            `Verificare la pressione dell'acqua.`
                        );
                    }
                    // Web push (v1.5)
                    if (machine.client_id) {
                        await sendPushNotification(machine.client_id,
                            '💧 NabulAir — Flusso acqua assente',
                            `${machine.machine_name || 'Impianto'}: verificare la pressione.`
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

        let command = null;
        if (machine_id) {
            const cmdResult = await queryWithRetry(
                `SELECT id, type, payload FROM commands
                 WHERE machine_id = $1 AND status = 'pending'
                 ORDER BY created_at ASC LIMIT 1`,
                [machine_id]
            );
            if (cmdResult.rows.length > 0) {
                const cmd = cmdResult.rows[0];
                // NON impostare 'sent' qui. L'ESP32 confermerà esplicitamente via /api/command/:id/confirm
                // Se la rete cade o l'ESP crasha, il comando resta 'pending' e viene riproposto al ping successivo
                command = { id: cmd.id, type: cmd.type, payload: cmd.payload };
                console.log(`📤 Comando in attesa di conferma: ${cmd.type} (ID ${cmd.id})`);
            }
        }

        // ========== LOGICA AUTO-SYNC ==========
        let requestSync = false;
        let pushPrograms = null;

        if (machine) {
            // Richiedi sync NTP se mai fatto o >24h
            let lastNtp = machine.last_ntp_sync;
            if (lastNtp) {
                const hoursSinceNtp = (Date.now() - new Date(lastNtp).getTime()) / 3600000;
                if (hoursSinceNtp > 24) requestSync = true;
            } else {
                requestSync = true; // mai sincronizzato
            }

            // Push programmi se cloud più recente
            const progResult = await queryWithRetry(
                'SELECT programs, updated_at FROM machine_programs WHERE machine_id = $1',
                [machine_id]
            );
            if (progResult.rows.length > 0) {
                const progUpdated = new Date(progResult.rows[0].updated_at);
                const lastProgSync = machine.last_prog_sync ? new Date(machine.last_prog_sync) : new Date(0);
                if (progUpdated > lastProgSync) {
                    pushPrograms = progResult.rows[0].programs;
                }
            }
        }

        // Normalizza pause_until in formato YYYY-MM-DD per l'ESP32
        let pauseUntilFormatted = null;
        if (machine?.pause_until) {
            const d = new Date(machine.pause_until);
            pauseUntilFormatted = d.toISOString().split('T')[0]; // "2026-06-15"
        }

        res.json({
            success: true,
            command,
            paused: machine?.paused || false,
            pause_until: pauseUntilFormatted,
            request_sync: requestSync,
            programs: pushPrograms
        });

    } catch (error) {
        console.error('❌ Errore ping:', error.message);
        console.error('   Stack:', error.stack);
        res.status(500).json({ success: false, command: null, error: error.message });
    }
});

app.post('/api/machines/:id/command', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);
    const { type } = req.body;
    let { payload } = req.body;

    // AGGIUNTI sync_time e start_cycle
    const ALLOWED_TYPES = ['update_programs', 'ota_firmware', 'ota_littlefs', 'reboot', 'sync_time', 'start_cycle', 'stop_cycle', 'wash_cycle', 'test_cycle'];
    if (!type || !ALLOWED_TYPES.includes(type)) {
        return res.status(400).json({ success: false, message: `Tipo comando non valido. Validi: ${ALLOWED_TYPES.join(', ')}` });
    }

    // I clienti non possono eseguire comandi "potenti" (OTA/reboot), solo admin/installatore
    const RESTRICTED_TYPES = ['ota_firmware', 'ota_littlefs', 'reboot'];
    if (req.user.role === 'client' && RESTRICTED_TYPES.includes(type)) {
        return res.status(403).json({ success: false, message: 'Operazione non consentita per il tuo ruolo' });
    }

    try {
        const machineResult = await queryWithRetry(
            'SELECT id, machine_name, installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (machineResult.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }

        const machine = machineResult.rows[0];

        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && machine.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        // ── OTA: risolvi firmware_id -> URL di download ──
        if ((type === 'ota_firmware' || type === 'ota_littlefs')) {
            const firmwareId = payload?.firmware_id;
            if (!firmwareId) {
                return res.status(400).json({ success: false, message: 'firmware_id obbligatorio nel payload' });
            }
            const fwResult = await queryWithRetry(
                'SELECT token, fw_type, filename FROM firmware_files WHERE id = $1',
                [firmwareId]
            );
            if (fwResult.rows.length === 0) {
                return res.status(404).json({ success: false, message: 'Firmware non trovato' });
            }
            const fw = fwResult.rows[0];
            const expectedType = type === 'ota_firmware' ? 'firmware' : 'littlefs';
            if (fw.fw_type !== expectedType) {
                return res.status(400).json({ success: false, message: `Il file caricato è di tipo "${fw.fw_type}", non "${expectedType}"` });
            }
            const baseUrl = `${req.protocol}://${req.get('host')}`;
            payload = { url: `${baseUrl}/api/firmware/download/${fw.token}`, filename: fw.filename };
        }

        await queryWithRetry(
            `UPDATE commands SET status = 'cancelled'
             WHERE machine_id = $1 AND type = $2 AND status = 'pending'`,
            [machineId, type]
        );

        const result = await queryWithRetry(
            `INSERT INTO commands (machine_id, type, payload, created_by)
             VALUES ($1, $2, $3, $4) RETURNING id`,
            [machineId, type, payload || null, req.user.id]
        );

        console.log(`📥 Comando ${type} in coda per macchina ${machineId} (ID cmd: ${result.rows[0].id})`);
        res.json({ success: true, command_id: result.rows[0].id, message: `Comando ${type} in coda — verrà eseguito al prossimo ping (max 60s)` });

    } catch (error) {
        console.error('Errore comando:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.post('/api/command/:id/confirm', async (req, res) => {
    const cmdId = parseInt(req.params.id);
    const { success, message } = req.body;
    try {
        await queryWithRetry(
            `UPDATE commands SET status = $1, executed_at = NOW()
             WHERE id = $2`,
            [success ? 'executed' : 'failed', cmdId]
        );
        console.log(`✅ Comando ${cmdId} ${success ? 'eseguito' : 'fallito'}: ${message || ''}`);

        // Aggiorna last_prog_sync / last_ntp_sync in base al tipo di comando
        if (success) {
            try {
                const cmdResult = await queryWithRetry(
                    'SELECT type, machine_id FROM commands WHERE id = $1',
                    [cmdId]
                );
                if (cmdResult.rows.length > 0) {
                    const cmd = cmdResult.rows[0];
                    if (cmd.type === 'sync_time') {
                        await queryWithRetry(
                            'UPDATE machines SET last_ntp_sync = NOW() WHERE id = $1',
                            [cmd.machine_id]
                        );
                        console.log(`🕒 last_ntp_sync aggiornato per macchina ${cmd.machine_id}`);
                    } else if (cmd.type === 'update_programs') {
                        await queryWithRetry(
                            'UPDATE machines SET last_prog_sync = NOW() WHERE id = $1',
                            [cmd.machine_id]
                        );
                        console.log(`📋 last_prog_sync aggiornato per macchina ${cmd.machine_id}`);
                    }
                }
            } catch (syncErr) {
                console.error('Errore aggiornamento sync timestamp:', syncErr.message);
            }
        }

        res.json({ success: true });
    } catch (error) {
        console.error('Errore confirm comando:', error.message);
        res.status(500).json({ success: false });
    }
});

app.get('/api/machines/:id/commands', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);
    try {
        const machineCheck = await queryWithRetry(
            'SELECT installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (machineCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const machine = machineCheck.rows[0];
        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && machine.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        const result = await queryWithRetry(
            `SELECT c.id, c.type, c.status, c.created_at, c.executed_at, u.username as sent_by
             FROM commands c
             LEFT JOIN users u ON c.created_by = u.id
             WHERE c.machine_id = $1
             ORDER BY c.created_at DESC LIMIT 20`,
            [machineId]
        );
        res.json({ success: true, commands: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─────────────────────────────────────────────
// FIRMWARE OTA — upload, lista, download, eliminazione
// ─────────────────────────────────────────────

const firmwareUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 4 * 1024 * 1024 }, // 4MB max
    fileFilter: (req, file, cb) => {
        if (!file.originalname.toLowerCase().endsWith('.bin')) {
            return cb(new Error('Il file deve avere estensione .bin'));
        }
        cb(null, true);
    }
});

// POST /api/firmware/upload — admin/installatore caricano un firmware (drag & drop)
app.post('/api/firmware/upload', authenticateToken, requireRole('admin', 'installer'), (req, res) => {
    firmwareUpload.single('firmware')(req, res, async (err) => {
        if (err) {
            return res.status(400).json({ success: false, message: err.message });
        }
        if (!req.file) {
            return res.status(400).json({ success: false, message: 'Nessun file ricevuto' });
        }
        const fwType = req.body.fw_type === 'littlefs' ? 'littlefs' : 'firmware';
        const version = (req.body.version || '').slice(0, 30) || null;
        const notes = (req.body.notes || '').slice(0, 255) || null;
        const token = crypto.randomBytes(24).toString('hex');

        try {
            const result = await queryWithRetry(
                `INSERT INTO firmware_files (token, filename, fw_type, version, notes, size_bytes, data, uploaded_by)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, filename, fw_type, version, notes, size_bytes, created_at`,
                [token, req.file.originalname, fwType, version, notes, req.file.size, req.file.buffer, req.user.id]
            );
            console.log(`📦 Firmware caricato: ${req.file.originalname} (${fwType}, ${(req.file.size/1024).toFixed(1)} KB) da ${req.user.username}`);
            res.json({ success: true, firmware: result.rows[0] });
        } catch (error) {
            console.error('Errore upload firmware:', error.message);
            res.status(500).json({ success: false, message: error.message });
        }
    });
});

// GET /api/firmware — lista firmware caricati (senza i dati binari)
app.get('/api/firmware', authenticateToken, requireRole('admin', 'installer'), async (req, res) => {
    try {
        const result = await queryWithRetry(
            `SELECT f.id, f.filename, f.fw_type, f.version, f.notes, f.size_bytes, f.created_at, u.username as uploaded_by
             FROM firmware_files f
             LEFT JOIN users u ON f.uploaded_by = u.id
             ORDER BY f.created_at DESC LIMIT 50`
        );
        res.json({ success: true, firmware: result.rows });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// DELETE /api/firmware/:id — admin/installatore eliminano un firmware
app.delete('/api/firmware/:id', authenticateToken, requireRole('admin', 'installer'), async (req, res) => {
    try {
        await queryWithRetry('DELETE FROM firmware_files WHERE id = $1', [req.params.id]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, message: error.message });
    }
});

// GET /api/firmware/download/:token — pubblico (l'ESP32 lo scarica senza autenticazione)
app.get('/api/firmware/download/:token', async (req, res) => {
    try {
        const result = await queryWithRetry(
            'SELECT filename, size_bytes, data FROM firmware_files WHERE token = $1',
            [req.params.token]
        );
        if (result.rows.length === 0) {
            return res.status(404).send('Firmware non trovato');
        }
        const fw = result.rows[0];
        res.set({
            'Content-Type': 'application/octet-stream',
            'Content-Disposition': `attachment; filename="${fw.filename}"`,
            'Content-Length': fw.size_bytes
        });
        res.send(fw.data);
    } catch (error) {
        console.error('Errore download firmware:', error.message);
        res.status(500).send('Errore server');
    }
});

// ==================== GESTIONE PROGRAMMI ====================

// GET /api/machines/:id/programs
app.get('/api/machines/:id/programs', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);

    try {
        const machineCheck = await queryWithRetry(
            'SELECT installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (machineCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const machine = machineCheck.rows[0];

        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && machine.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        const result = await queryWithRetry(
            'SELECT programs FROM machine_programs WHERE machine_id = $1',
            [machineId]
        );
        // FIX: garantisce che programs sia sempre un array, anche se nel DB c'è un oggetto corrotto
        let programs = [];
        if (result.rows.length > 0 && result.rows[0].programs) {
            const p = result.rows[0].programs;
            programs = Array.isArray(p) ? p : [];
        }
        res.json({ success: true, programs });
    } catch (error) {
        console.error('Errore GET programs:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// PUT /api/machines/:id/programs
app.put('/api/machines/:id/programs', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);
    const { programs, sendToDevice } = req.body;

    // FIX: validazione rigorosa che programs sia un array
    if (!programs || !Array.isArray(programs)) {
        return res.status(400).json({ success: false, message: 'Formato programmi non valido: deve essere un array' });
    }

    try {
        const machineCheck = await queryWithRetry(
            'SELECT installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (machineCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const machine = machineCheck.rows[0];

        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && machine.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        // Upsert dei programmi nel DB
        await queryWithRetry(
            `INSERT INTO machine_programs (machine_id, programs, updated_at)
             VALUES ($1, $2::jsonb, NOW())
             ON CONFLICT (machine_id) DO UPDATE SET
             programs = EXCLUDED.programs, updated_at = NOW()`,
            [machineId, JSON.stringify(programs)]
        );

        let commandId = null;
        if (sendToDevice === true) {
            const cmdResult = await queryWithRetry(
                `INSERT INTO commands (machine_id, type, payload, created_by)
                 VALUES ($1, $2, $3, $4) RETURNING id`,
                [machineId, 'update_programs', { programs }, req.user.id]
            );
            commandId = cmdResult.rows[0].id;
            console.log(`📥 Comando update_programs accodato per macchina ${machineId} (cmd ${commandId})`);
        }

        res.json({
            success: true,
            message: sendToDevice
                ? `Programmi salvati e invio richiesto (cmd #${commandId})`
                : 'Programmi salvati nel cloud'
        });
    } catch (error) {
        console.error('Errore PUT programs:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ==================== PAUSA GLOBALE PROGRAMMI ====================

app.get('/api/machines/:id/pause', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);
    try {
        const machineCheck = await queryWithRetry(
            'SELECT installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (machineCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const machine = machineCheck.rows[0];

        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && machine.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        const result = await queryWithRetry(
            'SELECT paused, pause_until FROM machines WHERE id = $1',
            [machineId]
        );

        const row = result.rows[0] || { paused: false, pause_until: null };

        // Se c'è una data di scadenza passata, auto-reset
        if (row.paused && row.pause_until) {
            const today = new Date();
            today.setHours(0,0,0,0);
            const pauseDate = new Date(row.pause_until);
            if (pauseDate < today) {
                await queryWithRetry(
                    'UPDATE machines SET paused = FALSE, pause_until = NULL WHERE id = $1',
                    [machineId]
                );
                return res.json({ success: true, paused: false, pause_until: null, auto_resumed: true });
            }
        }

        res.json({ success: true, paused: row.paused || false, pause_until: row.pause_until });
    } catch (error) {
        console.error('Errore GET pause:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

app.put('/api/machines/:id/pause', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);
    const { paused, pause_until } = req.body;

    if (typeof paused !== 'boolean') {
        return res.status(400).json({ success: false, message: 'Parametro paused (boolean) obbligatorio' });
    }

    try {
        const machineCheck = await queryWithRetry(
            'SELECT installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (machineCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const machine = machineCheck.rows[0];

        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && machine.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        await queryWithRetry(
            'UPDATE machines SET paused = $1, pause_until = $2 WHERE id = $3',
            [paused, pause_until || null, machineId]
        );

        console.log(`⏸️ Macchina ${machineId}: paused=${paused}, until=${pause_until || 'indefinito'}`);
        res.json({ success: true, message: paused ? 'Pausa attivata' : 'Programmi ripresi' });
    } catch (error) {
        console.error('Errore PUT pause:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─────────────────────────────────────────────
// POSIZIONE (per il meteo) — impostata dal cliente dall'app
// ─────────────────────────────────────────────

app.put('/api/machines/:id/location', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);
    const { latitude, longitude, location_name } = req.body;

    if (typeof latitude !== 'number' || typeof longitude !== 'number') {
        return res.status(400).json({ success: false, message: 'Coordinate latitude/longitude obbligatorie' });
    }
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
        return res.status(400).json({ success: false, message: 'Coordinate non valide' });
    }

    try {
        const machineCheck = await queryWithRetry(
            'SELECT installer_id, client_id FROM machines WHERE id = $1',
            [machineId]
        );
        if (machineCheck.rows.length === 0) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const machine = machineCheck.rows[0];

        if (req.user.role === 'installer' && machine.installer_id !== req.user.id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }
        if (req.user.role === 'client' && machine.client_id !== req.user.client_id) {
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        }

        await queryWithRetry(
            'UPDATE machines SET latitude = $1, longitude = $2, location_name = $3 WHERE id = $4',
            [latitude, longitude, location_name || null, machineId]
        );

        console.log(`📍 Macchina ${machineId}: posizione impostata su ${location_name || `${latitude},${longitude}`}`);
        res.json({ success: true, message: 'Posizione salvata' });
    } catch (error) {
        console.error('Errore PUT location:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─────────────────────────────────────────────
// STORICO CICLI (v1.5)
// ─────────────────────────────────────────────

// POST /api/machines/:mac/ciclo — chiamato dall'ESP32 a fine ciclo
app.post('/api/machines/:mac/ciclo', async (req, res) => {
    const mac = req.params.mac.toUpperCase();
    const { duration_sec, product, ml_consumed, zona, started_at } = req.body;

    try {
        const machineResult = await pool.query(
            'SELECT id FROM machines WHERE mac_address = $1', [mac]
        );
        if (!machineResult.rows.length) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const machineId = machineResult.rows[0].id;

        await pool.query(`
            INSERT INTO cicli (machine_id, started_at, duration_sec, product, ml_consumed, zona)
            VALUES ($1, $2, $3, $4, $5, $6)
        `, [
            machineId,
            started_at ? new Date(started_at) : new Date(),
            duration_sec || 0,
            product || 'insecticide',
            ml_consumed || 0,
            zona || 1
        ]);

        console.log(`📊 Ciclo registrato: macchina ${machineId}, ${duration_sec}s, ${product}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Errore report ciclo:', error.message);
        res.status(500).json({ success: false });
    }
});

// GET /api/machines/:id/cicli — storico cicli per dashboard e remote
app.get('/api/machines/:id/cicli', authenticateToken, async (req, res) => {
    const machineId = parseInt(req.params.id);
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const days  = parseInt(req.query.days) || 30;

    try {
        const machineCheck = await pool.query(
            'SELECT installer_id, client_id FROM machines WHERE id = $1', [machineId]
        );
        if (!machineCheck.rows.length) {
            return res.status(404).json({ success: false, message: 'Macchina non trovata' });
        }
        const m = machineCheck.rows[0];
        if (req.user.role === 'installer' && m.installer_id !== req.user.id)
            return res.status(403).json({ success: false, message: 'Accesso negato' });
        if (req.user.role === 'client' && m.client_id !== req.user.client_id)
            return res.status(403).json({ success: false, message: 'Accesso negato' });

        const result = await pool.query(`
            SELECT id, started_at, duration_sec, product, ml_consumed, zona
            FROM cicli
            WHERE machine_id = $1
              AND started_at >= NOW() - ($2 * INTERVAL '1 day')
            ORDER BY started_at DESC
            LIMIT $3
        `, [machineId, days, limit]);

        // Aggregato per giorno per il grafico
        const aggResult = await pool.query(`
            SELECT
                DATE(started_at) as giorno,
                COUNT(*) as num_cicli,
                SUM(duration_sec) as tot_sec,
                SUM(ml_consumed) as tot_ml,
                SUM(CASE WHEN product = 'repellent' THEN ml_consumed ELSE 0 END) as ml_rep,
                SUM(CASE WHEN product = 'insecticide' THEN ml_consumed ELSE 0 END) as ml_ins
            FROM cicli
            WHERE machine_id = $1
              AND started_at >= NOW() - ($2 * INTERVAL '1 day')
            GROUP BY DATE(started_at)
            ORDER BY giorno DESC
        `, [machineId, days]);

        res.json({
            success: true,
            cicli: result.rows,
            aggregato: aggResult.rows
        });
    } catch (error) {
        console.error('Errore GET cicli:', error.message);
        res.status(500).json({ success: false, message: error.message });
    }
});

// ─────────────────────────────────────────────
// WEB PUSH SUBSCRIPTION (v1.5)
// ─────────────────────────────────────────────

// GET /api/push/vapid-key — restituisce la chiave pubblica VAPID
app.get('/api/push/vapid-key', (req, res) => {
    const key = process.env.VAPID_PUBLIC_KEY;
    if (!key) return res.status(503).json({ success: false, message: 'Push non configurato' });
    res.json({ success: true, publicKey: key });
});

// POST /api/push/subscribe — salva la subscription del browser
app.post('/api/push/subscribe', authenticateToken, async (req, res) => {
    const { subscription } = req.body;
    if (!subscription || !subscription.endpoint) {
        return res.status(400).json({ success: false, message: 'Subscription non valida' });
    }
    try {
        // Salva sulla riga client dell'utente loggato
        const clientId = req.user.client_id;
        if (!clientId) {
            return res.status(400).json({ success: false, message: 'Solo i clienti possono iscriversi alle push' });
        }
        await pool.query(
            'UPDATE clients SET push_subscription = $1 WHERE id = $2',
            [JSON.stringify(subscription), clientId]
        );
        console.log(`🔔 Push subscription salvata per client ${clientId}`);
        res.json({ success: true });
    } catch (error) {
        console.error('Errore subscribe:', error.message);
        res.status(500).json({ success: false });
    }
});

// DELETE /api/push/unsubscribe — rimuove la subscription
app.delete('/api/push/unsubscribe', authenticateToken, async (req, res) => {
    try {
        const clientId = req.user.client_id;
        if (clientId) {
            await pool.query('UPDATE clients SET push_subscription = NULL WHERE id = $1', [clientId]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false });
    }
});

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

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'dashboard.html'));
});


startOfflineDetectionJob();

app.listen(PORT, () => {
    console.log(`✅ NabulAir Cloud avviato su porta ${PORT}`);
    console.log(`🔐 JWT_SECRET: ${JWT_SECRET ? '✅ Configurato' : '❌ MANCANTE'}`);
    console.log(`🗄️ Database: ${DATABASE_URL ? '✅ Configurato' : '❌ MANCANTE'}`);
    console.log(`🔒 SSL DB: DISABILITATO (per Railway internal network)`);
    console.log(`📱 Telegram: ${TELEGRAM_BOT_TOKEN ? '✅ Configurato' : '❌ DISABILITATO'}`);
    console.log(`📁 File statici: ${__dirname}`);
    console.log(`🚨 Sistema allarmi: ATTIVO`);
    console.log(`🔄 DB Auto-Retry: ATTIVO (max 3 tentativi)`);
    console.log(`🌐 CORS origini: ${ALLOWED_ORIGINS.join(', ')}`);
    console.log(`🕐 Offline Detection: ATTIVO (timeout 5min)`);
    console.log(`📦 Pre-registrazione macchine: ATTIVA (admin only)`);
    console.log(`👤 Client login: ATTIVO (creazione automatica utente)`);
    console.log(`📋 Gestione programmi macchina: ATTIVA`);
    console.log(`🔄 Auto-sync NTP e programmi: ATTIVA`);
});
