require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const morgan = require('morgan');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const RESET_SECRET = process.env.RESET_SECRET || 'UNSW2026';
const DATA_FILE = path.join(__dirname, 'results.json');

// ── Persistence ─────────────────────────────────────────
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (Array.isArray(data.submissions)) {
                return { submissions: data.submissions };
            }
        }
    } catch (err) {
        console.error('Failed to load saved data:', err.message);
    }
    return { submissions: [] };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ submissions }, null, 2));
    } catch (err) {
        console.error('Failed to save data:', err.message);
    }
}

let saveTimeout = null;
function scheduleSave() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(() => {
        saveData();
        saveTimeout = null;
    }, 2000);
}

let { submissions } = loadData();

// ── Middleware ───────────────────────────────────────────
app.use(morgan('short'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/mobile.html'));

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        connections: io.sockets.sockets.size,
        totalSubmissions: submissions.length
    });
});

// ── Socket.IO ───────────────────────────────────────────
io.on('connection', (socket) => {
    const connCount = io.sockets.sockets.size;

    socket.emit('init', {
        submissions,
        totalConnections: connCount
    });
    io.emit('updateConnections', connCount);

    socket.on('submitTeam', ({ stream, teamLetter, names, token }, callback) => {
        if (!token || typeof token !== 'string') return;
        if (!stream || typeof stream !== 'string') return;
        if (!teamLetter || typeof teamLetter !== 'string') return;
        if (!Array.isArray(names)) return;

        const cleanStream = stream.trim().substring(0, 30);
        const cleanLetter = teamLetter.trim().toUpperCase().substring(0, 3);
        const cleanNames = names
            .map(n => (typeof n === 'string' ? n.trim().substring(0, 30) : ''))
            .filter(n => n.length > 0)
            .slice(0, 5);

        if (!cleanStream || !cleanLetter || cleanNames.length < 2) return;

        const existing = submissions.find(s => s.token === token);
        if (existing) {
            if (typeof callback === 'function') {
                callback({ position: existing.position });
            }
            return;
        }

        const position = submissions.length + 1;
        const entry = {
            token,
            stream: cleanStream,
            teamLetter: cleanLetter,
            names: cleanNames,
            position,
            timestamp: Date.now()
        };

        submissions.push(entry);
        scheduleSave();

        const publicEntry = {
            stream: entry.stream,
            teamLetter: entry.teamLetter,
            names: entry.names,
            position: entry.position,
            timestamp: entry.timestamp
        };

        io.emit('newSubmission', publicEntry);

        if (typeof callback === 'function') {
            callback({ position });
        }
    });

    socket.on('getMySubmission', (token, callback) => {
        if (typeof callback !== 'function') return;
        const entry = submissions.find(s => s.token === token);
        if (entry) {
            callback({ position: entry.position, stream: entry.stream, teamLetter: entry.teamLetter, names: entry.names });
        } else {
            callback(null);
        }
    });

    socket.on('adminReset', (secret) => {
        if (secret === RESET_SECRET) {
            submissions = [];
            saveData();
            io.emit('resetAll');
        }
    });

    socket.on('disconnect', () => {
        io.emit('updateConnections', io.sockets.sockets.size);
    });

    socket.on('error', (err) => {
        console.error('Socket error:', err.message);
    });
});

// ── Start ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`DESN1000 Team Quiz live at: http://localhost:${PORT}`);
});

// ── Graceful shutdown ───────────────────────────────────
function shutdown(signal) {
    console.log(`\n${signal} received. Saving data and shutting down...`);
    if (saveTimeout) clearTimeout(saveTimeout);
    saveData();
    io.close(() => {
        server.close(() => {
            console.log('Server closed.');
            process.exit(0);
        });
    });
    setTimeout(() => process.exit(1), 5000);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err);
    if (saveTimeout) clearTimeout(saveTimeout);
    saveData();
    process.exit(1);
});
