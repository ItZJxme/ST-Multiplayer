// ST Multiplayer Extension - P2P Version
// Uses PeerJS for direct browser-to-browser connection (No server.js needed)

import { callPopup, getRequestHeaders, substituteParams, eventSource, event_types } from '../../../../script.js';
import { getContext, extension_settings, saveMetadataDebounced } from '../../../extensions.js';

const EXT_NAME = 'st-multiplayer';

let peer = null;
let hostConn = null;
let guests = [];
let isHost = false;
let roomCode = null;
let username = '';

// Load PeerJS
function loadPeerJS() {
    return new Promise((resolve, reject) => {
        if (window.Peer) return resolve();
        const script = document.createElement('script');
        script.src = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Failed to load PeerJS'));
        document.head.appendChild(script);
    });
}

if (!extension_settings[EXT_NAME]) {
    extension_settings[EXT_NAME] = { username: 'User' };
}

// ─── UI PANEL ───────────────────────────────────────────────────────────────
const panelHtml = `
<div id="stmp-panel">
    <div class="stmp-header">
        <span class="stmp-logo">🎮 ST Multiplayer (P2P)</span>
        <span id="stmp-status" class="stmp-status disconnected">● Offline</span>
    </div>

    <div class="stmp-section" id="stmp-setup">
        <input id="stmp-username" type="text" placeholder="Your name" maxlength="20" />

        <button id="stmp-create-btn" class="stmp-btn primary">＋ Create Room</button>

        <div class="stmp-divider">— or join —</div>

        <div class="stmp-row">
            <input id="stmp-join-code" type="text" placeholder="6-digit code" maxlength="6" />
            <button id="stmp-join-btn" class="stmp-btn primary small">Join</button>
        </div>
    </div>

    <div class="stmp-section hidden" id="stmp-room">
        <div class="stmp-room-info">
            <span>Room: <strong id="stmp-room-code-display">------</strong></span>
            <button id="stmp-copy-btn" class="stmp-btn icon" title="Copy code">📋</button>
        </div>
        <ul id="stmp-players" class="stmp-player-list"></ul>
        <button id="stmp-leave-btn" class="stmp-btn danger">🚪 Leave Room</button>
    </div>
</div>
`;

function setStatus(status, text) {
    const el = $('#stmp-status');
    el.removeClass('connected disconnected error').addClass(status);
    el.text(text);
}

function showNotification(msg) {
    toastr.success(msg, 'ST Multiplayer');
}

function updatePlayersList(players) {
    $('#stmp-players').empty();
    players.forEach(p => {
        const isMe = p.name === username ? ' (You)' : '';
        const role = p.isHost ? '👑' : '👤';
        $('#stmp-players').append(`<li><span>${role} ${p.name}${isMe}</span></li>`);
    });
}

function showRoom(code) {
    $('#stmp-setup').addClass('hidden');
    $('#stmp-room').removeClass('hidden');
    $('#stmp-room-code-display').text(code);
    updatePlayersList([{ name: username, isHost }]);
}

function showSetup() {
    $('#stmp-setup').removeClass('hidden');
    $('#stmp-room').addClass('hidden');
    roomCode = null;
    isHost = false;
    if (peer) {
        peer.destroy();
        peer = null;
    }
    hostConn = null;
    guests = [];
}

// ─── P2P HOST LOGIC ─────────────────────────────────────────────────────────
async function createRoom() {
    username = $('#stmp-username').val().trim();
    if (!username) return alert('Please enter your name');

    try {
        setStatus('disconnected', '● Connecting...');
        await loadPeerJS();

        roomCode = Math.floor(100000 + Math.random() * 900000).toString();
        const peerId = 'stmp-' + roomCode;
        
        peer = new window.Peer(peerId);

        peer.on('open', (id) => {
            isHost = true;
            showRoom(roomCode);
            setStatus('connected', '● Hosting');
            showNotification(`Room created! Code: ${roomCode}`);
        });

        peer.on('connection', (conn) => {
            conn.on('data', (data) => {
                if (data.type === 'join') {
                    conn.username = data.username;
                    guests.push(conn);
                    broadcastPlayers();
                    showNotification(`${data.username} joined`);
                } else if (data.type === 'message') {
                    // Forward message to ST
                    appendVisualMessage(data.username, data.text, true);
                    forwardToST(data.username, data.text);
                    // Broadcast to others
                    broadcastData({ type: 'message', username: data.username, text: data.text });
                }
            });

            conn.on('close', () => {
                guests = guests.filter(g => g !== conn);
                broadcastPlayers();
                showNotification(`${conn.username} left`);
            });
        });

        peer.on('error', (err) => {
            setStatus('error', '● Error');
            alert('PeerJS error: ' + err.message);
        });

    } catch (e) {
        alert('Failed to initialize P2P connection');
    }
}

function broadcastPlayers() {
    const players = [{ name: username, isHost: true }];
    guests.forEach(g => players.push({ name: g.username, isHost: false }));
    updatePlayersList(players);
    broadcastData({ type: 'room_update', players });
}

function broadcastData(data) {
    guests.forEach(g => g.send(data));
}

// ─── P2P GUEST LOGIC ────────────────────────────────────────────────────────
async function joinRoom(code) {
    username = $('#stmp-username').val().trim();
    if (!username) return alert('Please enter your name');

    if (code && typeof code !== 'string') {
        code = null;
    }

    const joinCode = code || $('#stmp-join-code').val().trim();
    if (!joinCode || joinCode.length !== 6) return alert('Enter a valid 6-digit code');

    try {
        setStatus('disconnected', '● Connecting...');
        await loadPeerJS();

        peer = new window.Peer();

        peer.on('open', () => {
            hostConn = peer.connect('stmp-' + joinCode);

            hostConn.on('open', () => {
                isHost = false;
                roomCode = joinCode;
                showRoom(roomCode);
                setStatus('connected', '● Connected');
                
                hostConn.send({ type: 'join', username });
            });

            hostConn.on('data', (data) => {
                if (data.type === 'room_update') {
                    updatePlayersList(data.players);
                } else if (data.type === 'message') {
                    appendVisualMessage(data.username, data.text, data.username === username);
                } else if (data.type === 'ai_response') {
                    appendVisualMessage(data.characterName, data.text, false);
                }
            });

            hostConn.on('close', () => {
                setStatus('error', '● Host disconnected');
                showSetup();
                alert('Host closed the room');
            });
        });

        peer.on('error', (err) => {
            setStatus('error', '● Error');
            alert('Connection failed. Make sure the code is correct.');
        });

    } catch (e) {
        alert('Failed to initialize P2P connection');
    }
}

// ─── CHAT INTERCEPTION ──────────────────────────────────────────────────────
function appendVisualMessage(senderName, text, isUserMsg) {
    const chatHtml = `
        <div class="mes ${isUserMsg ? 'user_mes' : ''}" is_user="${isUserMsg}">
            <div class="mes_text"><strong>[${senderName}]</strong> ${text}</div>
        </div>
    `;
    $('#chat').append(chatHtml);
    $('#chat').scrollTop($('#chat')[0].scrollHeight);
}

function forwardToST(senderName, text) {
    const context = getContext();
    const formattedText = `**[${senderName}]:** ${text}`;
    $('#send_textarea').val(formattedText);
    $('#send_but').click();
}

function bindChatInterception() {
    $('#send_but').on('click', function (e) {
        if (!roomCode) return; // ไม่ได้อยู่ในห้อง ปล่อยผ่านปกติ

        const text = $('#send_textarea').val().trim();
        if (!text) return;

        if (isHost) {
            // โฮสต์พิมพ์เอง -> กระจายให้ Guest ทุกคนเห็นภาพ
            broadcastData({ type: 'message', username, text });
        } else {
            // Guest พิมพ์ -> ส่งให้โฮสต์ไปรัน ST ให้
            e.preventDefault();
            e.stopImmediatePropagation();
            
            appendVisualMessage(username, text, true);
            if (hostConn) {
                hostConn.send({ type: 'message', username, text });
            }
            $('#send_textarea').val('');
        }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (msg) => {
        if (!isHost || !roomCode) return;
        if (msg.is_user) return; // ไม่ส่งซ้ำถ้าเป็นข้อความคน

        const context = getContext();
        const charName = msg.name || context.name2 || 'Bot';
        
        broadcastData({ type: 'ai_response', text: msg.mes, characterName: charName });
    });
}

function bindUI() {
    $('#stmp-create-btn').on('click', createRoom);
    $('#stmp-join-btn').on('click', joinRoom);
    
    $('#stmp-leave-btn').on('click', () => {
        showSetup();
        setStatus('disconnected', '● Not connected');
    });

    $('#stmp-copy-btn').on('click', () => {
        if (roomCode) {
            navigator.clipboard.writeText(roomCode);
            showNotification('Code copied to clipboard!');
        }
    });

    $('#stmp-username').val(extension_settings[EXT_NAME].username).on('input', function() {
        extension_settings[EXT_NAME].username = $(this).val();
        saveMetadataDebounced();
    });
}

function initExtension() {
    const container = document.createElement('div');
    container.innerHTML = panelHtml;
    $('#extensions_settings').append(container);
    
    bindUI();
    bindChatInterception();
    console.log('[ST Multiplayer P2P] Loaded');
}

jQuery(function () {
    initExtension();
});
