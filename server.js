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

// Question config — single source of truth for validation and state shape
const QUESTIONS = [
    { id: 'findLecture', type: 'yesno' },
    { id: 'moodleClear', type: 'yesno' },
    { id: 'hadFun',      type: 'yesno' },
    { id: 'metTeam',     type: 'yesno' },
    { id: 'enjoyedBBQ',  type: 'yesno' },
    { id: 'legoRating',  type: 'rating', min: 1, max: 5 }
];

function freshResults() {
    const r = {};
    for (const q of QUESTIONS) {
        if (q.type === 'yesno') {
            r[q.id] = { Yes: 0, No: 0 };
        } else if (q.type === 'rating') {
            r[q.id] = {};
            for (let i = q.min; i <= q.max; i++) r[q.id][String(i)] = 0;
        }
    }
    return r;
}

// ── Persistence ─────────────────────────────────────────
function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            return {
                results: data.results || freshResults(),
                votes: data.votes || {}
            };
        }
    } catch (err) {
        console.error('Failed to load saved data:', err.message);
    }
    return { results: freshResults(), votes: {} };
}

function saveData() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ results, votes }, null, 2));
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

let { results, votes } = loadData();

// ── Middleware ───────────────────────────────────────────
app.use(morgan('short'));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/mobile.html'));

app.get('/health', (req, res) => {
    res.json({
        status: 'ok',
        uptime: Math.floor(process.uptime()),
        connections: io.sockets.sockets.size,
        totalResponses: Object.keys(votes).length
    });
});

// ── Socket.IO ───────────────────────────────────────────
io.on('connection', (socket) => {
    const connCount = io.sockets.sockets.size;

    socket.emit('init', {
        results,
        totalConnections: connCount,
        totalResponses: Object.keys(votes).length
    });
    io.emit('updateConnections', connCount);

    socket.on('answer', ({ question, value, token }) => {
        if (!token || typeof token !== 'string') return;
        if (!results[question] || results[question][value] === undefined) return;

        if (!votes[token]) votes[token] = {};
        const prev = votes[token][question];
        if (prev === value) return;

        if (prev !== undefined && results[question][prev] !== undefined) {
            results[question][prev]--;
        }

        results[question][value]++;
        votes[token][question] = value;
        scheduleSave();

        io.emit('updateResults', {
            results,
            totalResponses: Object.keys(votes).length
        });
    });

    socket.on('getMyVotes', (token, callback) => {
        if (typeof callback === 'function') {
            callback(votes[token] || {});
        }
    });

    socket.on('adminReset', (secret) => {
        if (secret === RESET_SECRET) {
            results = freshResults();
            votes = {};
            saveData();
            io.emit('updateResults', { results, totalResponses: 0 });
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
    console.log(`DESN1000 First Week Poll live at: http://localhost:${PORT}`);
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
