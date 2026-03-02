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
const TEAM_LETTER_REGEX = /^[A-Z0-9]{1,3}$/;

// ── Persistence ─────────────────────────────────────────
function isValidSubmission(s) {
    if (!s || typeof s !== 'object') return false;
    const validToken = typeof s.token === 'string' && s.token.length > 0 && s.token.length <= 128;
    const validStream = typeof s.stream === 'string' && s.stream.trim().length > 0 && s.stream.trim().length <= 30;
    const validTeamLetter = typeof s.teamLetter === 'string' && TEAM_LETTER_REGEX.test(s.teamLetter.trim().toUpperCase());
    const validNames = Array.isArray(s.names)
        && s.names.length >= 2
        && s.names.length <= 5
        && s.names.every(n => typeof n === 'string' && n.trim().length > 0 && n.trim().length <= 30);
    const validPosition = Number.isInteger(s.position) && s.position > 0;
    const validTimestamp = Number.isFinite(s.timestamp) && s.timestamp > 0;
    return validToken && validStream && validTeamLetter && validNames && validPosition && validTimestamp;
}

function normalizeSubmission(s) {
    return {
        token: s.token.trim().substring(0, 128),
        stream: s.stream.trim().substring(0, 30),
        teamLetter: s.teamLetter.trim().toUpperCase().substring(0, 3),
        names: s.names
            .map(n => n.trim().substring(0, 30))
            .filter(Boolean)
            .slice(0, 5),
        position: s.position,
        timestamp: s.timestamp
    };
}

function renumberSubmissions(submissionList) {
    const ordered = [...submissionList].sort((a, b) => {
        if (a.position !== b.position) return a.position - b.position;
        return a.timestamp - b.timestamp;
    });
    return ordered.map((entry, index) => ({
        ...entry,
        position: index + 1
    }));
}

function loadData() {
    try {
        if (fs.existsSync(DATA_FILE)) {
            const data = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
            if (Array.isArray(data.submissions)) {
                const valid = [];
                const seenTokens = new Set();
                let malformedCount = 0;
                let duplicateTokenCount = 0;

                for (const raw of data.submissions) {
                    if (!isValidSubmission(raw)) {
                        malformedCount += 1;
                        continue;
                    }
                    const normalized = normalizeSubmission(raw);
                    if (seenTokens.has(normalized.token)) {
                        duplicateTokenCount += 1;
                        continue;
                    }
                    seenTokens.add(normalized.token);
                    valid.push(normalized);
                }

                const renumbered = renumberSubmissions(valid);
                const hadPositionDrift = renumbered.some((entry, index) => entry.position !== valid[index]?.position);

                if (malformedCount > 0) {
                    console.warn(`Discarded ${malformedCount} malformed submission(s) from saved data`);
                }
                if (duplicateTokenCount > 0) {
                    console.warn(`Discarded ${duplicateTokenCount} duplicate-token submission(s) from saved data`);
                }
                if (hadPositionDrift) {
                    console.warn('Renumbered submission positions to keep ordering contiguous');
                }
                return { submissions: renumbered };
            }
        }
    } catch (err) {
        console.error('Failed to load saved data:', err.message);
    }
    return { submissions: [] };
}

let isSaving = false;
let saveQueued = false;
function saveDataAsync() {
    if (isSaving) {
        saveQueued = true;
        return;
    }
    isSaving = true;

    let payload = '';
    try {
        payload = JSON.stringify({ submissions }, null, 2);
    } catch (err) {
        console.error('Failed to stringify data:', err.message);
        isSaving = false;
        return;
    }

    fs.writeFile(DATA_FILE, payload, (err) => {
        if (err) {
            console.error('Failed to save data asynchronously:', err.message);
        }
        isSaving = false;
        if (saveQueued) {
            saveQueued = false;
            saveDataAsync();
        }
    });
}

function saveDataSync() {
    try {
        fs.writeFileSync(DATA_FILE, JSON.stringify({ submissions }, null, 2));
        isSaving = false;
        saveQueued = false;
    } catch (err) {
        console.error('Failed to save data synchronously:', err.message);
    }
}

let saveTimeout = null;
function scheduleSave() {
    if (saveTimeout) return;
    saveTimeout = setTimeout(() => {
        saveDataAsync();
        saveTimeout = null;
    }, 2000);
}

let { submissions } = loadData();
const submissionsMap = new Map(submissions.map(s => [s.token, s]));

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
    console.log(`[CONNECT] Client connected (ID: ${socket.id}). Total online: ${connCount}`);

    const publicSubmissions = submissions.map(({ token, ...rest }) => rest);
    socket.emit('init', {
        submissions: publicSubmissions,
        totalConnections: connCount
    });
    io.emit('updateConnections', connCount);

    socket.on('submitTeam', (data, callback) => {
        const rejectSubmit = (message) => {
            if (typeof callback === 'function') callback({ error: message });
            console.warn(`[REJECT] ${message} (ID: ${socket.id}, IP: ${socket.handshake.address})`);
        };

        if (!data || typeof data !== 'object') {
            rejectSubmit('Invalid request');
            return;
        }
        const { stream, teamLetter, names, token } = data;

        if (!token || typeof token !== 'string' || token.length > 128) {
            rejectSubmit('Invalid token');
            return;
        }
        if (!stream || typeof stream !== 'string') {
            rejectSubmit('Stream is required');
            return;
        }
        if (!teamLetter || typeof teamLetter !== 'string') {
            rejectSubmit('Team letter is required');
            return;
        }
        if (!Array.isArray(names)) {
            rejectSubmit('Names must be an array');
            return;
        }

        const cleanStream = stream.trim().substring(0, 30);
        const cleanLetter = teamLetter.trim().toUpperCase().substring(0, 3);
        
        // Strict regex check for Team Letter (alphanumeric only)
        if (!TEAM_LETTER_REGEX.test(cleanLetter)) {
            rejectSubmit('Team letter must be alphanumeric');
            return;
        }

        const cleanNames = names
            .map(n => (typeof n === 'string' ? n.trim().substring(0, 30) : ''))
            .filter(n => n.length > 0)
            .slice(0, 5);

        if (!cleanStream || !cleanLetter || cleanNames.length < 2) {
            rejectSubmit('Please provide stream, team letter, and at least 2 names');
            return;
        }

        const existing = submissionsMap.get(token);
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
        submissionsMap.set(token, entry);
        scheduleSave();

        console.log(`[SUBMIT] Stream: ${entry.stream} | Team: ${entry.teamLetter} | Names: ${entry.names.join(', ')} | Position: #${entry.position}`);

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
        if (!token || typeof token !== 'string' || token.length > 128) {
            callback(null);
            return;
        }
        const entry = submissionsMap.get(token);
        if (entry) {
            callback({ position: entry.position, stream: entry.stream, teamLetter: entry.teamLetter, names: entry.names });
        } else {
            callback(null);
        }
    });

    socket.on('adminReset', (secret) => {
        if (secret === RESET_SECRET) {
            submissions = [];
            submissionsMap.clear();
            saveDataAsync();
            console.log('[ADMIN] All submissions have been reset.');
            io.emit('resetAll');
        } else {
            console.log(`[WARN] Failed admin reset attempt. (IP: ${socket.handshake.address})`);
        }
    });

    socket.on('disconnect', () => {
        console.log(`[DISCONNECT] Client disconnected (ID: ${socket.id}). Total online: ${io.sockets.sockets.size}`);
        io.emit('updateConnections', io.sockets.sockets.size);
    });

    socket.on('error', (err) => {
        console.error('Socket error:', err.message);
    });
});

// ── Start ───────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        console.error(`Port ${PORT} is already in use. Close the other process or set a different PORT in .env`);
        process.exit(1);
    }
    console.error('Server error:', err);
});
server.listen(PORT, () => {
    console.log(`DESN1000 Team Quiz live at: http://localhost:${PORT}`);
});

// ── Graceful shutdown ───────────────────────────────────
let isShuttingDown = false;
function shutdown(signal) {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\n${signal} received. Saving data and shutting down...`);
    if (saveTimeout) clearTimeout(saveTimeout);
    saveDataSync();
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
    saveDataSync();
    process.exit(1);
});
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled promise rejection:', reason);
});
