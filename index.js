// ST Multiplayer Extension
// Requires: relay server running (server.js)

import { callPopup, getRequestHeaders, substituteParams, eventSource, event_types } from '../../../../script.js';
import { getContext, extension_settings, saveMetadataDebounced } from '../../../extensions.js';
import { oai_settings } from '../../../openai.js';

const EXT_NAME = 'st-multiplayer';
const DEFAULT_SERVER = 'http://localhost:3333';

// Load socket.io from relay server dynamically
let socket = null;
let isHost = false;
let roomCode = null;
let username = '';

// Extension settings
if (!extension_settings[EXT_NAME]) {
    extension_settings[EXT_NAME] = {
        serverUrl: DEFAULT_SERVER,
        username: 'User'
    };
}

// ─── UI PANEL ───────────────────────────────────────────────────────────────
const panelHtml = `
<div id="stmp-panel">
    <div class="stmp-header">
        <span class="stmp-logo">🎮 ST Multiplayer</span>
        <span id="stmp-status" class="stmp-status disconnected">● Not connected</span>
    </div>

    <div class="stmp-section" id="stmp-setup">
        <input id="stmp-username" type="text" placeholder="Your name" maxlength="20" />

        <div class="stmp-row">
            <input id="stmp-server-url" type="text" placeholder="Server URL" value="${extension_settings[EXT_NAME].serverUrl}" />
        </div>

        <label class="stmp-checkbox-label">
            <input type="checkbox" id="stmp-public" /> Make room public
        </label>

        <button id="stmp-create-btn" class="stmp-btn primary">＋ Create Room</button>

        <div class="stmp-divider">— or join —</div>

        <button id="stmp-list-btn" class="stmp-btn secondary">🔍 Public Rooms</button>

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
        <div id="stmp-user-list"></div>
        <button id="stmp-leave-btn" class="stmp-btn danger">Leave Room</button>
    </div>

    <div class="stmp-section" id="stmp-public-list-section" style="display:none;">
        <div class="stmp-divider">Public Rooms</div>
        <div id="stmp-public-rooms-list"></div>
        <button id="stmp-close-list-btn" class="stmp-btn secondary small">Close</button>
    </div>
</div>
`;

// ─── INIT ────────────────────────────────────────────────────────────────────
jQuery(async () => {
    // Add panel to extensions tab
    $('#extensions_settings').append(panelHtml);

    // Prefill username
    $('#stmp-username').val(extension_settings[EXT_NAME].username);

    // Load socket.io client from server & bind UI
    bindUI();
    bindChatInterception(); // เริ่มดักจับการพิมพ์
});

function bindUI() {
    $('#stmp-create-btn').on('click', createRoom);
    $('#stmp-join-btn').on('click', joinRoom);
    $('#stmp-leave-btn').on('click', leaveRoom);
    $('#stmp-copy-btn').on('click', copyRoomCode);
    $('#stmp-list-btn').on('click', fetchPublicRooms);
    $('#stmp-close-list-btn').on('click', () => $('#stmp-public-list-section').hide());

    $('#stmp-username').on('change', () => {
        extension_settings[EXT_NAME].username = $('#stmp-username').val();
        saveMetadataDebounced();
    });

    $('#stmp-server-url').on('change', () => {
        extension_settings[EXT_NAME].serverUrl = $('#stmp-server-url').val();
        saveMetadataDebounced();
    });
}

// ─── CHAT INTERCEPTION (NEW) ────────────────────────────────────────────────
function bindChatInterception() {
    // ดักจับการกดปุ่ม Send
    $('#send_but').on('click', handleChatInput);

    // ดักจับการกด Enter ในช่องข้อความ
    $('#send_textarea').on('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            handleChatInput(e);
        }
    });

    // ฟังเหตุการณ์ตอนที่ AI เจนข้อความเสร็จ (Host Only)
    if (typeof eventSource !== 'undefined' && event_types && event_types.MESSAGE_RECEIVED) {
        eventSource.on(event_types.MESSAGE_RECEIVED, (messageId) => {
            if (!isHost || !roomCode || !socket) return;
            const context = getContext();
            // ตรวจสอบว่ามีข้อความอยู่ใน chat จริง
            if (!context || !context.chat || !context.chat[messageId]) return;
            
            const msg = context.chat[messageId];
            if (msg.is_user) return; // ถ้าเป็นข้อความของ User ให้ข้าม (เราสนใจเฉพาะ AI)

            // ส่งข้อความบอทที่เพิ่งเจนเสร็จไปให้ทุกคนในห้อง
            const charName = msg.name || context.name2 || 'Bot';
            socket.emit('ai_response', { text: msg.mes, characterName: charName });
        });
    } else {
        console.warn('[STMP] eventSource not available, AI responses will not be broadcasted automatically.');
    }
}

function handleChatInput(e) {
    if (!roomCode || !socket) return; // ถ้าไม่ได้อยู่ในห้อง ปล่อยให้ ST ทำงานตามปกติ

    const text = $('#send_textarea').val().trim();
    if (!text) return;

    if (!isHost) {
        // ถ้าเป็น Guest (หยุดการส่งข้อความให้ AI ท้องถิ่น และส่งไปที่ Server แทน)
        e.preventDefault();
        e.stopImmediatePropagation();

        socket.emit('user_message', { text });
        $('#send_textarea').val(''); // ล้างช่องแชท

        // แปะข้อความของตัวเองลงในหน้าจอ
        appendVisualMessage(username, text, true);
    } else {
        // ถ้าเป็น Host (ปล่อยให้ ST รัน AI ตามปกติ แต่กระจายข้อความให้ Guest ด้วย)
        socket.emit('user_message', { text });
        // ไม่ต้อง preventDefault เพื่อให้ ST นำข้อความเข้าแชทและเจน AI ตามปกติ
    }
}

// ฟังก์ชันสำหรับจำลองข้อความลงในแชท (ใช้เฉพาะ Guest หรือดึงประวัติเก่า)
function appendVisualMessage(senderName, text, isUserMsg) {
    const chatHtml = `
        <div class="mes ${isUserMsg ? 'user_mes' : ''}" is_user="${isUserMsg}">
            <div class="mes_text"><strong>[${senderName}]</strong> ${text}</div>
        </div>
    `;
    $('#chat').append(chatHtml);
    $('#chat').scrollTop($('#chat')[0].scrollHeight); // เลื่อนจอลงมาล่างสุด
}

// ─── SOCKET CONNECTION ───────────────────────────────────────────────────────
function connectSocket(serverUrl) {
    return new Promise((resolve, reject) => {
        const scriptSrc = `${serverUrl}/socket.io/socket.io.js`;
        if (window.io) {
            socket = window.io(serverUrl);
            setupSocketEvents();
            resolve();
            return;
        }

        const script = document.createElement('script');
        script.src = scriptSrc;
        script.onload = () => {
            socket = window.io(serverUrl);
            setupSocketEvents();
            resolve();
        };
        script.onerror = () => reject(new Error('Cannot connect to relay server'));
        document.head.appendChild(script);
    });
}

function setupSocketEvents() {
    socket.on('connect', () => {
        setStatus('connected', '● Connected');
    });

    socket.on('disconnect', () => {
        setStatus('disconnected', '● Disconnected');
        showSetup();
    });

    socket.on('new_message', (msg) => {
        if (msg.username !== username) {
            // Host ทำหน้าที่ประมวลผลข้อความและนำเข้าแชทผ่าน Native UI แล้ว จึงไม่ต้อง append ซ้ำอีก
            if (!isHost) {
                appendVisualMessage(msg.username, msg.text, msg.type === 'user');
            }
            if (msg.type === 'user') {
                showNotification(`${msg.username}: ${msg.text}`);
            }
        }
    });

    socket.on('room_update', (info) => {
        updateUserList(info.users);
    });

    socket.on('user_joined', ({ username: u }) => {
        showNotification(`${u} joined the room`);
    });

    socket.on('user_left', ({ username: u }) => {
        showNotification(`${u} left the room`);
    });

    // HOST: trigger AI generation when guest sends message
    socket.on('trigger_ai', async ({ username: sender, text }) => {
        if (!isHost) return;
        try {
            // แปะชื่อคนส่งไว้หน้าข้อความ แล้วส่งเข้า SillyTavern ให้รัน AI ตามปกติ
            const fakeUserMessage = `[${sender}]: ${text}`;
            
            const input = document.getElementById('send_textarea');
            const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
            nativeInputValueSetter.call(input, fakeUserMessage);
            input.dispatchEvent(new Event('input', { bubbles: true }));
            document.getElementById('send_but').click();
        } catch (e) {
            console.error('[STMP] AI generation trigger failed:', e);
        }
    });

    socket.on('you_are_host', () => {
        isHost = true;
        showNotification('You are now the host');
    });
}

// ─── ROOM ACTIONS ────────────────────────────────────────────────────────────
async function createRoom() {
    username = $('#stmp-username').val().trim();
    if (!username) return alert('Please enter your name');

    const serverUrl = $('#stmp-server-url').val().trim();
    const isPublic = $('#stmp-public').is(':checked');

    try {
        await connectSocket(serverUrl);

        socket.emit('create_room', { username, isPublic, roomName: `${username}'s Room` }, (res) => {
            if (!res.success) return alert('Failed to create room');
            roomCode = res.code;
            isHost = true;
            showRoom(roomCode);
            showNotification(`Room created! Code: ${roomCode}`);
        });
    } catch (e) {
        alert(`Cannot connect to server: ${serverUrl}\nMake sure the relay server is running.`);
    }
}

async function joinRoom(code) {
    username = $('#stmp-username').val().trim();
    if (!username) return alert('Please enter your name');

    // ป้องกันกรณีที่ jQuery ส่ง Event object มาแทนตัวหนังสือ (เวลาคลิกปุ่ม Join ตรงๆ)
    if (code && typeof code !== 'string') {
        code = null;
    }

    const joinCode = code || $('#stmp-join-code').val().trim();
    if (!joinCode || joinCode.length !== 6) return alert('Enter a valid 6-digit code');

    const serverUrl = $('#stmp-server-url').val().trim();

    try {
        await connectSocket(serverUrl);

        socket.emit('join_room', { username, code: joinCode }, (res) => {
            if (!res.success) return alert(`Error: ${res.error}`);
            roomCode = joinCode;
            isHost = false;
            showRoom(joinCode);

            // ดึงข้อความเก่ามาแสดง (ถ้ามี)
            if (res.messages && res.messages.length > 0) {
                res.messages.forEach(msg => {
                    if (msg.username !== username) {
                        appendVisualMessage(msg.username, msg.text, msg.type === 'user');
                    }
                });
            }
        });
    } catch (e) {
        alert(`Cannot connect to server: ${serverUrl}`);
    }
}

function leaveRoom() {
    if (socket) socket.disconnect();
    roomCode = null;
    isHost = false;
    showSetup();
    setStatus('disconnected', '● Not connected');
}

function copyRoomCode() {
    navigator.clipboard.writeText(roomCode);
    showNotification('Room code copied!');
}

async function fetchPublicRooms() {
    const serverUrl = $('#stmp-server-url').val().trim();
    try {
        const res = await fetch(`${serverUrl}/rooms`);
        const rooms = await res.json();

        const list = $('#stmp-public-rooms-list');
        list.empty();

        if (rooms.length === 0) {
            list.append('<div class="stmp-no-rooms">No public rooms found</div>');
        } else {
            rooms.forEach(r => {
                list.append(`
                    <div class="stmp-room-item">
                        <span>${r.name} (${r.userCount} users)</span>
                        <button class="stmp-btn primary small" onclick="window.stmpJoinPublic('${r.code}')">Join</button>
                    </div>
                `);
            });
        }

        $('#stmp-public-list-section').show();
    } catch (e) {
        alert('Cannot fetch rooms. Is the server running?');
    }
}

window.stmpJoinPublic = (code) => {
    $('#stmp-public-list-section').hide();
    joinRoom(code);
};

// ─── AI GENERATION (HOST ONLY) ───────────────────────────────────────────────
// ฟังก์ชันนี้ถูกลบออกเนื่องจากเปลี่ยนมาใช้ Native Event (MESSAGE_RECEIVED) ผ่าน eventSource


// ─── UI HELPERS ──────────────────────────────────────────────────────────────
function showRoom(code) {
    $('#stmp-setup').addClass('hidden');
    $('#stmp-room').removeClass('hidden');
    $('#stmp-room-code-display').text(code);
}

function showSetup() {
    $('#stmp-setup').removeClass('hidden');
    $('#stmp-room').addClass('hidden');
    $('#stmp-user-list').empty();
}

function setStatus(state, text) {
    $('#stmp-status').attr('class', `stmp-status ${state}`).text(text);
}

function updateUserList(users) {
    const list = $('#stmp-user-list');
    list.empty();
    users.forEach(u => {
        list.append(`<div class="stmp-user">${u.isHost ? '👑' : '👤'} ${u.username}</div>`);
    });
}

function showNotification(text) {
    const notif = $(`<div class="stmp-notif">${text}</div>`);
    $('body').append(notif);
    setTimeout(() => notif.addClass('show'), 10);
    setTimeout(() => { notif.removeClass('show'); setTimeout(() => notif.remove(), 400); }, 3000);
}