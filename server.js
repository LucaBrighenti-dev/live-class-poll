const express = require('express');
const http = require('http');
const { Server } = require("socket.io");
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// State
let votes = { "Aerospace": 0, "Mechanical": 0, "Mechatronic": 0, "Nuclear": 0 };
let totalConnections = 0;

io.on('connection', (socket) => {
    totalConnections++;
    
    // Send initial state to the new connector
    socket.emit('init', { votes, totalConnections });
    io.emit('updateConnections', totalConnections);

    socket.on('vote', (team) => {
        if (votes[team] !== undefined) {
            votes[team]++;
            // Broadcast new scores to everyone
            io.emit('updateVotes', votes);
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
