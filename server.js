const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// Root URL → send students to the voting page
app.get('/', (req, res) => {
    res.redirect('/mobile.html');
});

// State
let votes = { "Aerospace": 0, "Mechanical": 0, "Mechatronic": 0, "Nuclear": 0 };
let excited = { "EXTREMELY!!!!": 0, "Very": 0, "A Little Bit": 0, "Not Very": 0 };
let totalConnections = 0;

io.on('connection', (socket) => {
    totalConnections++;
    
    // Send initial state to the new connector
    socket.emit('init', { votes, totalConnections, excited });
    io.emit('updateConnections', totalConnections);

    socket.on('vote', (team) => {
        if (votes[team] !== undefined) {
            votes[team]++;
            io.emit('updateVotes', votes);
        }
    });

    socket.on('excited', (answer) => {
        if (excited[answer] !== undefined) {
            excited[answer]++;
            io.emit('updateExcited', excited);
        }
    });

    // Hidden reset — only the presenter knows the secret code
    socket.on('adminReset', (secret) => {
        if (secret === 'UNSW2026') {
            votes = { "Aerospace": 0, "Mechanical": 0, "Mechatronic": 0, "Nuclear": 0 };
            excited = { "EXTREMELY!!!!": 0, "Very": 0, "A Little Bit": 0, "Not Very": 0 };
            io.emit('updateVotes', votes);
            io.emit('updateExcited', excited);
            io.emit('resetAll');
        }
    });

    socket.on('disconnect', () => {
        totalConnections--;
        io.emit('updateConnections', totalConnections);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 System Online: http://localhost:${PORT}`);
});
