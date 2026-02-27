const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const db = require('./database');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });

app.use(cors());
app.use(express.json());

// Serve static uploaded files so the Flutter app can load images via HTTP
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Ensure uploads directory exists
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir);
}

// Configure Multer for processing incoming Image payloads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        // Generate a unique filename: timestamp-random.ext
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

// =======================
// REST API ENDPOINTS
// =======================

// In-memory OTP Cache for prototyping
const otpCache = new Map();

// 1. Request OTP (Generates 6-digit cryptographic code)
app.post('/api/auth/request-otp', (req, res) => {
    const { phone } = req.body;
    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    // Generate random 6-digit OTP
    const otp = Math.floor(100000 + Math.random() * 900000).toString();

    // Store in cache with 5-minute expiry
    otpCache.set(phone, { otp, timestamp: Date.now() });

    // In a production app, we would fire an HTTP request to Twilio/Fast2SMS here:
    // e.g. axios.post('https://api.twilio.com/2010-04-01/Accounts/.../Messages.json', ...)

    console.log(`\n==========================================`);
    console.log(`🔒 SECURE SMS GATEWAY (SIMULATED)`);
    console.log(`📲 To: ${phone}`);
    console.log(`🔑 OTP Code: ${otp}`);
    console.log(`==========================================\n`);

    // DEV MODE: return OTP in response so no terminal inspection needed.
    // In production: remove 'dev_otp' and fire Twilio/Fast2SMS here instead.
    res.json({ message: 'OTP Sent successfully', success: true, dev_otp: otp });
});

// 2. Validate OTP & Login User
app.post('/api/auth/verify-otp', (req, res) => {
    const { phone, otp } = req.body;

    if (!phone || !otp) return res.status(400).json({ error: 'Phone and OTP required' });

    const cachedData = otpCache.get(phone);

    // Check if OTP exists and matches
    if (!cachedData || cachedData.otp !== otp) {
        return res.status(401).json({ error: 'Invalid or expired OTP' });
    }

    // Check expiry (5 minutes = 300,000 ms)
    if (Date.now() - cachedData.timestamp > 300000) {
        otpCache.delete(phone);
        return res.status(401).json({ error: 'OTP has expired' });
    }

    // OTP Valid - Clear cache
    otpCache.delete(phone);

    // Login or Create Account in SQLite
    db.get('SELECT id, phone_number, name, profile_image FROM users WHERE phone_number = ?', [phone], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });

        if (user) {
            res.json({ message: 'Login successful', user });
        } else {
            // New User flow
            const stmt = db.prepare('INSERT INTO users (phone_number, name) VALUES (?, ?)');
            stmt.run(phone, 'Switch User', function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'User created', user: { id: this.lastID, phone_number: phone, name: 'Switch User' } });
            });
            stmt.finalize();
        }
    });
});

// 2.5 Find or Create User by Phone (For New Chat FAB)
app.post('/api/users/find_or_create', (req, res) => {
    const { phone, name } = req.body;

    if (!phone) return res.status(400).json({ error: 'Phone number required' });

    db.get('SELECT id, phone_number, name FROM users WHERE phone_number = ?', [phone], (err, user) => {
        if (err) return res.status(500).json({ error: err.message });

        if (user) {
            res.json({ message: 'User found', user });
        } else {
            // Create a stub user so we can message them
            const displayName = name || 'Unknown Switch User';
            const stmt = db.prepare('INSERT INTO users (phone_number, name) VALUES (?, ?)');
            stmt.run(phone, displayName, function (err) {
                if (err) return res.status(500).json({ error: err.message });
                res.json({ message: 'User created', user: { id: this.lastID, phone_number: phone, name: displayName } });
            });
            stmt.finalize();
        }
    });
});

// 2.55 Get Single User Profile
app.get('/api/users/:userId', (req, res) => {
    const userId = req.params.userId;
    db.get('SELECT id, phone_number, name, profile_image, status_content, status_updated_at FROM users WHERE id = ?', [userId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!row) return res.status(404).json({ error: 'User not found' });
        res.json(row);
    });
});

// 2.6 Update User Profile (Name, Image, or Status)
app.put('/api/users/:userId', (req, res) => {
    const userId = req.params.userId;
    const { name, profile_image, status_content } = req.body;

    if (!name && !profile_image && !status_content) {
        return res.status(400).json({ error: 'At least one field is required to update' });
    }

    let updates = [];
    let params = [];

    if (name) {
        updates.push('name = ?');
        params.push(name);
    }
    if (profile_image) {
        updates.push('profile_image = ?');
        params.push(profile_image);
    }
    if (status_content) {
        updates.push('status_content = ?');
        params.push(status_content);
        updates.push("status_updated_at = datetime('now')");
    }

    params.push(userId);

    const query = `UPDATE users SET ${updates.join(', ')} WHERE id = ?`;

    const stmt = db.prepare(query);
    stmt.run(params, function (err) {
        if (err) return res.status(500).json({ error: err.message });

        // Fetch and return the fully updated user object
        db.get('SELECT id, phone_number, name, profile_image FROM users WHERE id = ?', [userId], (err, row) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Profile updated successfully', user: row });
        });
    });
    stmt.finalize();
});

// 3. Batch Contact Synchronization
// Receives an array of phone numbers from the mobile device and returns registered users
app.post('/api/contacts/sync', (req, res) => {
    const { contacts } = req.body;

    if (!contacts || !Array.isArray(contacts)) {
        return res.status(400).json({ error: 'Valid contacts array required' });
    }

    if (contacts.length === 0) return res.json([]);

    // Generate dynamic placeholders for the SQL IN clause (?, ?, ?)
    const placeholders = contacts.map(() => '?').join(',');

    const query = `
        SELECT id, phone_number, name, profile_image, status_content, status_updated_at 
        FROM users 
        WHERE phone_number IN (${placeholders})
    `;

    db.all(query, contacts, (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 2. Fetch Chat History
app.get('/api/messages/:userId/:contactId', (req, res) => {
    const userId = req.params.userId;
    const contactId = req.params.contactId;
    const isGhost = req.query.ghost === 'true' ? 1 : 0;

    const query = `
        SELECT m.id, m.content, m.created_at, m.is_ghost, m.sender_id, m.receiver_id
        FROM messages m
        WHERE ((m.sender_id = ? AND m.receiver_id = ?) OR (m.sender_id = ? AND m.receiver_id = ?))
        AND m.is_ghost = ?
        ORDER BY m.created_at ASC
    `;

    db.all(query, [userId, contactId, contactId, userId, isGhost], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

app.delete('/api/messages/:userId/:contactId', (req, res) => {
    const { userId, contactId } = req.params;
    const isGhost = req.query.ghost === 'true' ? 1 : 0;

    // Clear chat HISTORY for this particular combination
    const query = `
        DELETE FROM messages 
        WHERE ((sender_id = ? AND receiver_id = ?) OR (sender_id = ? AND receiver_id = ?))
        AND is_ghost = ?
    `;

    db.run(query, [userId, contactId, contactId, userId, isGhost], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Chat cleared effectively' });
    });
});

// Delete specific message
app.delete('/api/message/:messageId', (req, res) => {
    const { messageId } = req.params;
    db.run('DELETE FROM messages WHERE id = ?', [messageId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Message deleted successfully' });
    });
});

// Edit specific message
app.put('/api/message/:messageId', (req, res) => {
    const { messageId } = req.params;
    const { content } = req.body;
    db.run('UPDATE messages SET content = ? WHERE id = ?', [content, messageId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Message edited successfully' });
    });
});

// 4. Fetch Inbox (Recent Chats)
app.get('/api/inbox/:userId', (req, res) => {
    const userId = req.params.userId;
    const isGhost = req.query.ghost === 'true' ? 1 : 0;

    const query = `
        SELECT 
            CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END as contact_id,
            u.name as contact_name,
            u.phone_number,
            u.profile_image,
            u.status_content,
            u.status_updated_at,
            MAX(m.created_at) as time,
            m.content as preview,
            SUM(CASE WHEN m.receiver_id = ? AND m.is_read = 0 THEN 1 ELSE 0 END) as unread_count
        FROM messages m
        JOIN users u ON u.id = CASE WHEN m.sender_id = ? THEN m.receiver_id ELSE m.sender_id END
        WHERE (m.sender_id = ? OR m.receiver_id = ?) AND m.is_ghost = ?
        GROUP BY contact_id
        ORDER BY MAX(m.created_at) DESC
    `;

    db.all(query, [userId, userId, userId, userId, userId, isGhost], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// ========================
// GROUP CHAT ROUTES
// ========================

// Create a Group (max 50 members including creator)
app.post('/api/groups/create', (req, res) => {
    const { name, creator_id, member_ids } = req.body;
    if (!name || !creator_id) return res.status(400).json({ error: 'name and creator_id required' });

    const allMembers = [...new Set([creator_id, ...(member_ids || [])])];
    if (allMembers.length > 50) return res.status(400).json({ error: 'Max 50 members allowed' });

    db.run('INSERT INTO groups (name, creator_id) VALUES (?, ?)', [name, creator_id], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        const groupId = this.lastID;

        // Add all members
        const stmt = db.prepare('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)');
        allMembers.forEach(uid => stmt.run(groupId, uid));
        stmt.finalize();

        res.json({ message: 'Group created', group: { id: groupId, name, creator_id } });
    });
});

// Add member to group
app.post('/api/groups/:groupId/add', (req, res) => {
    const { groupId } = req.params;
    const { user_id } = req.body;

    // Check current count
    db.get('SELECT COUNT(*) as cnt FROM group_members WHERE group_id = ?', [groupId], (err, row) => {
        if (err) return res.status(500).json({ error: err.message });
        if (row.cnt >= 50) return res.status(400).json({ error: 'Group is full (max 50)' });

        db.run('INSERT OR IGNORE INTO group_members (group_id, user_id) VALUES (?, ?)', [groupId, user_id], function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ message: 'Member added' });
        });
    });
});

// Remove member from group
app.delete('/api/groups/:groupId/remove/:userId', (req, res) => {
    const { groupId, userId } = req.params;
    db.run('DELETE FROM group_members WHERE group_id = ? AND user_id = ?', [groupId, userId], function (err) {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ message: 'Member removed' });
    });
});

// Fetch all groups for a user
app.get('/api/groups/user/:userId', (req, res) => {
    const { userId } = req.params;
    const query = `
        SELECT g.id, g.name, g.creator_id, g.group_icon, g.created_at,
               (SELECT COUNT(*) FROM group_members gm2 WHERE gm2.group_id = g.id) as member_count,
               (SELECT m.content FROM messages m WHERE m.group_id = g.id ORDER BY m.created_at DESC LIMIT 1) as last_message
        FROM groups g
        JOIN group_members gm ON gm.group_id = g.id
        WHERE gm.user_id = ?
        ORDER BY g.created_at DESC
    `;
    db.all(query, [userId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Fetch group members
app.get('/api/groups/:groupId/members', (req, res) => {
    const { groupId } = req.params;
    const query = `
        SELECT u.id, u.name, u.phone_number, u.profile_image
        FROM users u
        JOIN group_members gm ON gm.user_id = u.id
        WHERE gm.group_id = ?
    `;
    db.all(query, [groupId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// Fetch group message history
app.get('/api/groups/:groupId/messages', (req, res) => {
    const { groupId } = req.params;
    const query = `
        SELECT m.id, m.content, m.created_at, m.sender_id, u.name as sender_name, u.profile_image as sender_avatar
        FROM messages m
        JOIN users u ON u.id = m.sender_id
        WHERE m.group_id = ?
        ORDER BY m.created_at ASC
    `;
    db.all(query, [groupId], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// 5. Image Upload Endpoint
app.post('/api/upload', upload.single('media'), (req, res) => {
    if (!req.file) {
        return res.status(400).json({ error: 'No file uploaded' });
    }

    // Return relative URL to the file
    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({ message: 'Upload successful', url: fileUrl });
});

// =======================
// WEBSOCKETS (LIVE CHAT)
// =======================
const activeUsers = new Map();
// Tracks active calls: userId -> contactId they're calling/in call with
const activeCalls = new Map();

io.on('connection', (socket) => {
    console.log(`User connected: ${socket.id}`);

    // User joins with their ID
    socket.on('register', (userId) => {
        activeUsers.set(userId, socket.id);
        console.log(`User ${userId} registered socket ${socket.id}`);
    });

    // Handle incoming messages
    socket.on('send_message', (data) => {
        const { sender_id, receiver_id, content, is_ghost } = data;
        const ghostFlag = is_ghost ? 1 : 0;

        // Save to Database
        const stmt = db.prepare('INSERT INTO messages (sender_id, receiver_id, content, is_ghost) VALUES (?, ?, ?, ?)');
        stmt.run(sender_id, receiver_id, content, ghostFlag, function (err) {
            if (err) return console.error('DB Error:', err.message);

            const savedMessage = {
                id: this.lastID,
                sender_id,
                receiver_id,
                content,
                is_ghost: ghostFlag,
                created_at: new Date().toISOString()
            };

            // Broadcast to Sender (Confirmation)
            socket.emit('message_sent', savedMessage);

            // Forward to Receiver if they are online
            const receiverSocketId = activeUsers.get(receiver_id);
            if (receiverSocketId) {
                io.to(receiverSocketId).emit('receive_message', savedMessage);
            }
        });
        stmt.finalize();
    });

    // Group Message via WebSocket
    socket.on('send_group_message', (data) => {
        const { sender_id, group_id, content } = data;
        if (!sender_id || !group_id || !content) return;

        // Save message to DB with group_id
        const stmt = db.prepare(
            'INSERT INTO messages (sender_id, receiver_id, content, group_id) VALUES (?, ?, ?, ?)'
        );
        stmt.run(sender_id, 0, content, group_id, function (err) {
            if (err) { console.error('Group message save error:', err.message); return; }

            const savedMessage = {
                id: this.lastID,
                sender_id,
                group_id,
                content,
                created_at: new Date().toISOString()
            };

            // Confirm to sender
            socket.emit('group_message_sent', savedMessage);

            // Broadcast to all other online group members
            db.all('SELECT user_id FROM group_members WHERE group_id = ?', [group_id], (err, rows) => {
                if (err) return;
                rows.forEach(row => {
                    if (row.user_id !== sender_id) {
                        const memberSocket = activeUsers.get(row.user_id);
                        if (memberSocket) {
                            io.to(memberSocket).emit('receive_group_message', savedMessage);
                        }
                    }
                });
            });
        });
        stmt.finalize();
    });

    // Real-time message Edit and Delete
    socket.on('edit_message', (data) => {
        const { messageId, content, receiver_id } = data;
        const receiverSocketId = activeUsers.get(receiver_id);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('message_edited', { id: messageId, content });
        }
    });

    socket.on('delete_message', (data) => {
        const { messageId, receiver_id } = data;
        const receiverSocketId = activeUsers.get(receiver_id);
        if (receiverSocketId) {
            io.to(receiverSocketId).emit('message_deleted', { id: messageId });
        }
    });

    socket.on('disconnect', () => {
        console.log(`User disconnected: ${socket.id}`);
        for (let [key, value] of activeUsers.entries()) {
            if (value === socket.id) {
                // Also release any active calls for this user
                const partnerId = activeCalls.get(key);
                if (partnerId) {
                    activeCalls.delete(partnerId);
                    // Notify partner that call ended
                    const partnerSocket = activeUsers.get(partnerId);
                    if (partnerSocket) io.to(partnerSocket).emit('end_call');
                }
                activeCalls.delete(key);
                activeUsers.delete(key);
            }
        }
    });

    // Call Signaling — with active call tracking to prevent overlaps
    socket.on('call_user', (data) => {
        const { caller_id, receiver_id, caller_name, type } = data;
        const receiverSocketId = activeUsers.get(receiver_id);

        if (!receiverSocketId) {
            // Receiver not online — notify caller
            socket.emit('call_rejected', { reason: 'unavailable' });
            return;
        }

        // Check if either party is already in a call
        if (activeCalls.has(caller_id) || activeCalls.has(receiver_id)) {
            socket.emit('call_rejected', { reason: 'busy' });
            return;
        }

        // Mark both parties as in a call
        activeCalls.set(caller_id, receiver_id);
        activeCalls.set(receiver_id, caller_id);

        io.to(receiverSocketId).emit('incoming_call', { caller_id, caller_name, type });
    });

    socket.on('reject_call', (data) => {
        const { caller_id } = data;
        const callerSocketId = activeUsers.get(caller_id);

        // Release the call lock if set during ring phase
        const receiverId = activeCalls.get(caller_id);
        if (receiverId) {
            activeCalls.delete(caller_id);
            activeCalls.delete(receiverId);
        }

        if (callerSocketId) {
            io.to(callerSocketId).emit('call_rejected');
        }
    });

    // WebRTC Real Signaling — relay only, no state mutation
    socket.on('webrtc_offer', (data) => {
        const receiverSocketId = activeUsers.get(data.to);
        if (receiverSocketId) io.to(receiverSocketId).emit('webrtc_offer', data);
    });

    socket.on('webrtc_answer', (data) => {
        const receiverSocketId = activeUsers.get(data.to);
        if (receiverSocketId) io.to(receiverSocketId).emit('webrtc_answer', data);
    });

    socket.on('webrtc_ice_candidate', (data) => {
        const receiverSocketId = activeUsers.get(data.to);
        if (receiverSocketId) io.to(receiverSocketId).emit('webrtc_ice_candidate', data);
    });

    // Audio → Video call upgrade
    socket.on('upgrade_video', (data) => {
        const receiverSocketId = activeUsers.get(data.to);
        if (receiverSocketId) io.to(receiverSocketId).emit('upgrade_video', data);
    });

    socket.on('end_call', (data) => {
        const receiverSocketId = activeUsers.get(data.to);

        // Release the call tracking
        activeCalls.delete(data.to);
        // find who was calling them
        for (let [uid, rid] of activeCalls.entries()) {
            if (rid === data.to) activeCalls.delete(uid);
        }

        if (receiverSocketId) io.to(receiverSocketId).emit('end_call');
    });
});

// 6. Auto-cleanup: Data Retention limits (Run every 24h)
setInterval(() => {
    // Retain messages for 60 days
    db.run(`DELETE FROM messages WHERE created_at <= datetime('now', '-60 days')`, function (err) {
        if (err) {
            console.error('Messages auto-cleanup error:', err.message);
        } else if (this.changes > 0) {
            console.log(`[Data Retention] Deleted ${this.changes} messages older than 60 days.`);
        }
    });

    // Expire/Clear Statuses after 24 hours
    db.run(`UPDATE users SET status_content = NULL, status_updated_at = NULL WHERE status_updated_at <= datetime('now', '-24 hours')`, function (err) {
        if (err) {
            console.error('Status auto-cleanup error:', err.message);
        } else if (this.changes > 0) {
            console.log(`[Data Retention] Cleared ${this.changes} expired statuses older than 24 hours.`);
        }
    });
}, 24 * 60 * 60 * 1000); // Check once a day

// Start Server — use PORT env variable for cloud platforms (Railway, Render, etc.)
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Switch Backend running on port ${PORT}`);
});
