const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, 'switch_database.sqlite');
const db = new sqlite3.Database(dbPath, (err) => {
    if (err) {
        console.error('Error opening database', err.message);
    } else {
        console.log('Connected to the SQLite database.');
        initializeDatabase();
    }
});

function initializeDatabase() {
    db.serialize(() => {
        // Create Users Table
        db.run(`CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            phone_number TEXT UNIQUE NOT NULL,
            name TEXT,
            profile_image TEXT,
            status_content TEXT,
            status_updated_at DATETIME,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        // Create Messages Table
        db.run(`CREATE TABLE IF NOT EXISTS messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            sender_id INTEGER NOT NULL,
            receiver_id INTEGER NOT NULL,
            content TEXT NOT NULL,
            is_ghost BOOLEAN DEFAULT 0,
            is_read BOOLEAN DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (sender_id) REFERENCES users (id),
            FOREIGN KEY (receiver_id) REFERENCES users (id)
        )`);

        // Create Groups Table
        db.run(`CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            creator_id INTEGER NOT NULL,
            group_icon TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (creator_id) REFERENCES users (id)
        )`);

        // Create Group Members Association Table
        db.run(`CREATE TABLE IF NOT EXISTS group_members (
            group_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (group_id, user_id),
            FOREIGN KEY (group_id) REFERENCES groups (id),
            FOREIGN KEY (user_id) REFERENCES users (id)
        )`);

        console.log('Database schema successfully initialized.');

        // Ensure columns exist (For existing DBs without them)
        db.run("ALTER TABLE users ADD COLUMN status_content TEXT", (err) => { });
        db.run("ALTER TABLE users ADD COLUMN status_updated_at DATETIME", (err) => { });
        db.run("ALTER TABLE messages ADD COLUMN group_id INTEGER REFERENCES groups(id)", (err) => { });
        db.run("ALTER TABLE messages ADD COLUMN edited INTEGER DEFAULT 0", (err) => { });
    });
}

module.exports = db;
