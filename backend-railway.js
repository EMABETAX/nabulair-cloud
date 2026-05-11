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

if (!JWT_SECRET) {
    console.error('❌ ERRORE: JWT_SECRET non configurato!');
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error('❌ ERRORE: DATABASE_URL non configurato!');
    process.exit(1);
}

// ============================================
// DATABASE CONNECTION
// ============================================
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

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
        `).catch(e => console.log('Colonne già esistenti'));
        
        console.log('✅ Database inizializzato correttamente');
    } catch (err) {
        console.error('❌ Errore init database:', err.message);
    }
}

pool.connect(async (err) => {
    if (err) {
        console.error('❌ Errore DB:', err.message);
    } else {
        console.log('✅ Connesso a PostgreSQL su Railway!');
        await initDatabase();
    }
});

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

// ============================================
// API LOGIN
// ============================================
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ success: false, message: 'Credenziali richieste' });
    }
    
    try {
        const result = await pool.query(
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
            { id: user.id, username: user.username, role: user.role },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        
        res.json({
            success: true,
            token,
            user: { id: user.id, username: user.username, role: user.role }
        });
        
    } catch (error) {
        console.error('Errore login:', error.message);
        res.status(500).json({ success: false, message: 'Errore server' });
    }
});

// ============================================
// API MACCHINE (protetta)
// ============================================
app.get('/api/machines', authenticateToken, async (req, res) => {
    try {
        const result = await pool.query(`
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
            ORDER BY m.status DESC, m.last_seen DESC NULLS LAST
        `);
        
        res.json({ success: true, machines: result.rows });
        
    } catch (error) {
        console.error('Errore GET machines:', error.message);
        res.status(500).json({ success: false, message: 'Errore caricamento' });
    }
});

// ============================================
// API ALLARMI ATTIVI (protetta)
// ============================================
app.get('/api/alerts', authenticateToken, async (req, res) => {
    try {
        let query = `
            SELECT a.*, m.machine_name, c.name as client_name
            FROM alerts a
            JOIN machines m ON a.machine_id = m.id
            LEFT JOIN clients c ON m.client_id = c.id
            WHERE a.status = 'active'
            ORDER BY a.created_at DESC
        `;
        
        if (req.user.role === 'installer') {
            query += ` AND m.installer_id = ${req.user.id}`;
        }
        
        const result = await pool.query(query);
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
        await pool.query(
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
        const result = await pool.query(`
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
// API REGISTRAZIONE ESP32 (pubblica)
// ============================================
app.post('/api/register', async (req, res) => {
    const { mac_address, ip, version } = req.body;
    
    if (!mac_address || !ip) {
        return res.status(400).json({ success: false, message: 'Dati mancanti' });
    }
    
    const macRegex = /^([0-9A-F]{2}[:-]){5}([0-9A-F]{2})$/i;
    if (!macRegex.test(mac_address)) {
        return res.status(400).json({ success: false, message: 'MAC address non valido' });
    }
    
    try {
        await pool.query(
            `INSERT INTO machines (mac_address, sta_ip, firmware_version, status, last_seen)
             VALUES ($1, $2, $3, 'online', NOW())
             ON CONFLICT (mac_address) DO UPDATE SET 
             sta_ip = EXCLUDED.sta_ip, last_seen = NOW(), status = 'online'`,
            [mac_address.toUpperCase(), ip, version || '1.0']
        );
        
        console.log(`📡 ESP32 registrato: ${mac_address}`);
        res.json({ success: true, message: 'Registrato con successo' });
        
    } catch (error) {
        console.error('Errore registrazione:', error.message);
        res.status(500).json({ success: false });
    }
});

// ============================================
// API PING ESP32 (con stato allarmi)
// ============================================
app.post('/api/ping', async (req, res) => {
    const { mac_address, ip, water_ok, insecticide_ok, flow, status } = req.body;
    
    if (!mac_address) {
        return res.status(400).json({ success: false });
    }
    
    try {
        // Aggiorna macchina con i nuovi stati
        await pool.query(
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
        
        // Ottieni machine_id
        const machineResult = await pool.query(
            'SELECT id FROM machines WHERE mac_address = $1',
            [mac_address]
        );
        
        const machine_id = machineResult.rows[0]?.id;
        
        if (machine_id) {
            // Gestione allarme insetticida
            if (insecticide_ok === false) {
                await pool.query(
                    `INSERT INTO alerts (machine_id, type, message)
                     VALUES ($1, 'insecticide', '⚠️ Insetticida esaurito - Verificare il contenitore')
                     ON CONFLICT DO NOTHING`,
                    [machine_id]
                );
                console.log(`🚨 Allarme: Insetticida esaurito su macchina ${machine_id}`);
            }
            
            // Gestione allarme acqua
            if (water_ok === false) {
                await pool.query(
                    `INSERT INTO alerts (machine_id, type, message)
                     VALUES ($1, 'water', '⚠️ Flusso acqua assente - Verificare la pressione')
                     ON CONFLICT DO NOTHING`,
                    [machine_id]
                );
                console.log(`🚨 Allarme: Acqua assente su macchina ${machine_id}`);
            }
            
            // Risolvi allarmi se tutto OK
            if (water_ok === true && insecticide_ok === true) {
                await pool.query(
                    `UPDATE alerts 
                     SET status = 'resolved', resolved_at = NOW()
                     WHERE machine_id = $1 AND status = 'active'`,
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
    try {
        await pool.query('SELECT 1');
        res.json({ 
            status: 'healthy', 
            timestamp: new Date().toISOString(),
            uptime: process.uptime()
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy', 
            error: error.message,
            timestamp: new Date().toISOString()
        });
    }
});

// ============================================
// ROOT ENDPOINT
// ============================================
app.get('/', (req, res) => {
    res.json({ 
        message: 'NabulAir Cloud API', 
        version: '2.1',
        status: 'online',
        features: ['Alerts', 'Telegram Ready'],
        endpoints: [
            'GET /',
            'GET /health',
            'GET /dashboard',
            'GET /remote',
            'POST /api/login',
            'GET /api/machines (protected)',
            'GET /api/alerts (protected)',
            'POST /api/register',
            'POST /api/ping'
        ]
    });
});

// ============================================
// AVVIO SERVER
// ============================================
app.listen(PORT, () => {
    console.log(`✅ NabulAir Cloud avviato su porta ${PORT}`);
    console.log(`🔐 JWT_SECRET: ${JWT_SECRET ? '✅ Configurato' : '❌ MANCANTE'}`);
    console.log(`🗄️ Database: ${DATABASE_URL ? '✅ Configurato' : '❌ MANCANTE'}`);
    console.log(`📁 File statici: ${__dirname}`);
    console.log(`🚨 Sistema allarmi: ATTIVO`);
});
