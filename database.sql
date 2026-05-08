-- Crea database
CREATE DATABASE nabulair_cloud;
USE nabulair_cloud;

-- Tabella clienti
CREATE TABLE clients (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(100),
    phone VARCHAR(20),
    address TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabella macchine
CREATE TABLE machines (
    id INT AUTO_INCREMENT PRIMARY KEY,
    client_id INT,
    machine_name VARCHAR(100) NOT NULL,
    mac_address VARCHAR(17) UNIQUE NOT NULL,
    sta_ip VARCHAR(15),
    last_seen TIMESTAMP NULL,
    firmware_version VARCHAR(10) DEFAULT '1.0',
    status ENUM('online', 'offline', 'warning', 'error') DEFAULT 'offline',
    notes TEXT,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (client_id) REFERENCES clients(id)
);

-- Tabella registrazione ESP32
CREATE TABLE esp_devices (
    id INT AUTO_INCREMENT PRIMARY KEY,
    mac_address VARCHAR(17) UNIQUE NOT NULL,
    auth_token VARCHAR(64) UNIQUE NOT NULL,
    registered_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Tabella log connessioni
CREATE TABLE connection_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    machine_id INT,
    connected_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    ip_address VARCHAR(45),
    FOREIGN KEY (machine_id) REFERENCES machines(id)
);

-- Tabella comandi remoti
CREATE TABLE remote_commands (
    id INT AUTO_INCREMENT PRIMARY KEY,
    machine_id INT,
    command VARCHAR(50),
    payload JSON,
    status ENUM('pending', 'executed', 'failed') DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    executed_at TIMESTAMP NULL,
    FOREIGN KEY (machine_id) REFERENCES machines(id)
);

-- Inserisci macchine di esempio
INSERT INTO clients (name, email) VALUES 
('John Spa Milano', 'john@example.com'),
('Hotel Roma', 'hotel@roma.it'),
('Ristorante Napoli', 'info@ristorante.it');

INSERT INTO machines (client_id, machine_name, mac_address, status) VALUES
(1, 'NabulAir Milano Centro', 'AA:BB:CC:DD:EE:01', 'online'),
(2, 'NabulAir Roma Termini', 'AA:BB:CC:DD:EE:02', 'online'),
(3, 'NabulAir Napoli Porto', 'AA:BB:CC:DD:EE:03', 'offline');