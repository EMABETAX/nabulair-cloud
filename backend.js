const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

// Database connection
const db = mysql.createConnection({
    host: 'localhost',
    user: 'root',
    password: 'tuapassword',
    database: 'nabulair_cloud'
});

// ============================================
// API PER ESP32 (REGISTRAZIONE E PING)
// ============================================

// Registrazione ESP32
app.post('/api/register', (req, res) => {
    const { mac_address, ip, version } = req.body;
    
    // Genera token unico
    const auth_token = crypto.randomBytes(32).toString('hex');
    
    // Cerca o crea macchina
    db.query(
        `INSERT INTO machines (mac_address, sta_ip, firmware_version, status, last_seen)
         VALUES (?, ?, ?, 'online', NOW())
         ON DUPLICATE KEY UPDATE 
         sta_ip = ?, last_seen = NOW(), status = 'online'`,
        [mac_address, ip, version, ip],
        (err, result) => {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ 
                    success: true, 
                    auth_token: auth_token,
                    message: 'Registrato con successo'
                });
            }
        }
    );
});

// Ping / Heartbeat (ESP32 chiama ogni minuto)
app.post('/api/ping', (req, res) => {
    const { mac_address, ip, flow, insecticide, status } = req.body;
    
    db.query(
        `UPDATE machines 
         SET last_seen = NOW(), 
             sta_ip = ?,
             status = 'online'
         WHERE mac_address = ?`,
        [ip, mac_address],
        (err) => {
            if (err) {
                res.json({ success: false });
            } else {
                // Salva metriche in una tabella separata (opzionale)
                res.json({ success: true });
            }
        }
    );
});

// ============================================
// API PER DASHBOARD CENTRALE
// ============================================

// Lista tutte le macchine
app.get('/api/machines', (req, res) => {
    db.query(
        `SELECT m.*, c.name as client_name, 
         TIMESTAMPDIFF(MINUTE, last_seen, NOW()) as minutes_offline
         FROM machines m
         LEFT JOIN clients c ON m.client_id = c.id
         ORDER BY m.status DESC, c.name`,
        (err, results) => {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                // Calcola tempo offline
                results.forEach(m => {
                    if (m.status === 'online' && m.minutes_offline > 5) {
                        m.status = 'offline';
                    }
                });
                res.json({ success: true, machines: results });
            }
        }
    );
});

// Dettaglio singola macchina (per la vista remota)
app.get('/api/machine/:id', (req, res) => {
    const { id } = req.params;
    
    db.query(
        `SELECT m.*, c.name as client_name, c.email, c.phone
         FROM machines m
         LEFT JOIN clients c ON m.client_id = c.id
         WHERE m.id = ?`,
        [id],
        (err, results) => {
            if (err) {
                res.json({ success: false, error: err.message });
            } else if (results.length === 0) {
                res.json({ success: false, error: 'Macchina non trovata' });
            } else {
                res.json({ success: true, machine: results[0] });
            }
        }
    );
});

// Invia comando a una macchina
app.post('/api/command/:machineId', (req, res) => {
    const { machineId } = req.params;
    const { command, payload } = req.body;
    
    db.query(
        `INSERT INTO remote_commands (machine_id, command, payload)
         VALUES (?, ?, ?)`,
        [machineId, command, JSON.stringify(payload)],
        (err) => {
            if (err) {
                res.json({ success: false, error: err.message });
            } else {
                res.json({ success: true, message: 'Comando inviato' });
            }
        }
    );
});

// ESP32 ritira comandi pendenti
app.get('/api/commands/:mac_address', (req, res) => {
    const { mac_address } = req.params;
    
    db.query(
        `SELECT rc.*, m.id as machine_id
         FROM remote_commands rc
         JOIN machines m ON rc.machine_id = m.id
         WHERE m.mac_address = ? AND rc.status = 'pending'
         ORDER BY rc.created_at ASC`,
        [mac_address],
        (err, results) => {
            if (err) {
                res.json({ success: false });
            } else {
                res.json({ success: true, commands: results });
            }
        }
    );
});

// Aggiorna stato comando eseguito
app.post('/api/command/status', (req, res) => {
    const { command_id, status, response } = req.body;
    
    db.query(
        `UPDATE remote_commands 
         SET status = ?, executed_at = NOW()
         WHERE id = ?`,
        [status, command_id],
        (err) => {
            res.json({ success: !err });
        }
    );
});

app.listen(3000, () => {
    console.log('✅ Cloud server avviato su porta 3000');
});