const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const rooms = {}; // roomCode -> { users: [], messages: [], hostId }

function generateRoomCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// REST: list public rooms
app.get('/rooms', (req, res) => {
    const publicRooms = Object.entries(rooms)
        .filter(([, r]) => r.isPublic)
        .map(([code, r]) => ({
            code,
            name: r.name,
            userCount: r.users.length
        }));
    res.json(publicRooms);
});

io.on('connection', (socket) => {
    console.log(`[+] Connected: ${socket.id}`);

    // Create room
    socket.on('create_room', ({ username, isPublic, roomName }, cb) => {
        const code = generateRoomCode();
        rooms[code] = {
            name: roomName || `${username}'s Room`,
            isPublic: !!isPublic,
            hostId: socket.id,
            users: [{ id: socket.id, username, isHost: true }],
            messages: []
        };
        socket.join(code);
        socket.roomCode = code;
        socket.username = username;
        console.log(`[Room] Created: ${code} by ${username}`);
        cb({ success: true, code });
        io.to(code).emit('room_update', getRoomInfo(code));
    });

    // Join room
    socket.on('join_room', ({ username, code }, cb) => {
        const room = rooms[code];
        if (!room) return cb({ success: false, error: 'Room not found' });

        room.users.push({ id: socket.id, username, isHost: false });
        socket.join(code);
        socket.roomCode = code;
        socket.username = username;

        console.log(`[Room] ${username} joined ${code}`);
        cb({ success: true, messages: room.messages });
        io.to(code).emit('room_update', getRoomInfo(code));
        io.to(code).emit('user_joined', { username });
    });

    // User sends a message
    socket.on('user_message', ({ text }) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const msg = {
            type: 'user',
            username: socket.username,
            text,
            timestamp: Date.now()
        };
        room.messages.push(msg);

        // Broadcast to all in room
        io.to(code).emit('new_message', msg);

        // Tell the HOST to trigger AI generation
        const host = room.users.find(u => u.isHost);
        if (host) {
            io.to(host.id).emit('trigger_ai', { username: socket.username, text });
        }
    });

    // Host sends AI response back
    socket.on('ai_response', ({ text, characterName }) => {
        const code = socket.roomCode;
        const room = rooms[code];
        if (!room) return;

        const msg = {
            type: 'ai',
            username: characterName || 'Bot',
            text,
            timestamp: Date.now()
        };
        room.messages.push(msg);
        io.to(code).emit('new_message', msg);
    });

    // Disconnect
    socket.on('disconnect', () => {
        const code = socket.roomCode;
        if (!code || !rooms[code]) return;

        const room = rooms[code];
        room.users = room.users.filter(u => u.id !== socket.id);

        if (room.users.length === 0) {
            delete rooms[code];
            console.log(`[Room] Deleted: ${code}`);
        } else {
            // If host left, assign new host
            if (room.hostId === socket.id) {
                room.users[0].isHost = true;
                room.hostId = room.users[0].id;
                io.to(room.hostId).emit('you_are_host');
            }
            io.to(code).emit('room_update', getRoomInfo(code));
            io.to(code).emit('user_left', { username: socket.username });
        }

        console.log(`[-] Disconnected: ${socket.username}`);
    });
});

function getRoomInfo(code) {
    const room = rooms[code];
    return {
        code,
        name: room.name,
        users: room.users.map(u => ({ username: u.username, isHost: u.isHost }))
    };
}

const PORT = process.env.PORT || 3333;
server.listen(PORT, () => {
    console.log(`✅ ST Multiplayer Relay Server running on port ${PORT}`);
});
