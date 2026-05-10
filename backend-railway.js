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
// Serve i file dalla cartella corrente
app.use(express.static(__dirname));

// Rotte esplicite per le pagine HTML
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
    console.error('👉 Aggiungi JWT_SECRET alle variabili d\'ambiente su Railway');
    process.exit(1);
}

if (!DATABASE_URL) {
    console.error('❌ ERRORE: DATABASE_URL non configurato!');
    console.error('👉 Collega il database al backend su Railway');
    process.exit(1);
}

// ============================================
// DATABASE CONNECTION
// ============================================
const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.connect((err) => {
    if (err) {
        console.error('❌ Errore DB:', err.message);
    } else {
        console.log('✅ Connesso a PostgreSQL su Railway!');
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
    
    // Valida formato MAC address
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
// API PING ESP32
// ============================================
app.post('/api/ping', async (req, res) => {
    const { mac_address, ip } = req.body;
    
    if (!mac_address) {
        return res.status(400).json({ success: false });
    }
    
    try {
        await pool.query(
            `UPDATE machines SET last_seen = NOW(), sta_ip = COALESCE($1, sta_ip), status = 'online'
             WHERE mac_address = $2`,
            [ip, mac_address]
        );
        
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
        version: '2.0',
        status: 'online',
        endpoints: [
            'GET /',
            'GET /health',
            'GET /dashboard',
            'GET /remote',
            'POST /api/login',
            'GET /api/machines (protected)',
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
});