const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion, makeCacheableSignalKeyStore, jidDecode, downloadContentFromMessage } = require('@whiskeysockets/baileys');
const pino = require('pino');
const express = require('express');
const http = require('http');
const socketIO = require('socket.io');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const sharp = require('sharp');
const axios = require('axios');
const { fromBuffer } = require('file-type');
const settings = require('./settings');

// ==================== GLOBAL STATE ====================
let sock;
let connectionState = 'disconnected';
let qrCodeData = '';
let pairingCode = '';
let botStartTime = Date.now();
let activeChats = {};
let settingsCache = { ...settings };
let viewOnceStore = new Map(); // For anti-viewonce
let messageStore = new Map();  // For anti-delete

// Web Dashboard
const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.static('public')); // if any static files

// ==================== WEB DASHBOARD ROUTES ====================
app.get('/', (req, res) => {
    res.send(`
    <!DOCTYPE html>
    <html>
    <head>
        <title>${settings.botName} Dashboard</title>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <style>
            :root { --bg: #0f172a; --card: #1e293b; --text: #e2e8f0; --accent: #3b82f6; --danger: #ef4444; --success: #22c55e; }
            body { font-family: 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); margin: 0; padding: 20px; display: flex; flex-direction: column; align-items: center; }
            .container { max-width: 600px; width: 100%; }
            .card { background: var(--card); border-radius: 16px; padding: 24px; margin-bottom: 20px; box-shadow: 0 4px 6px rgba(0,0,0,0.3); }
            h1 { text-align: center; margin-bottom: 20px; }
            .status-badge { display: inline-block; padding: 4px 12px; border-radius: 20px; font-weight: bold; }
            .connected { background: var(--success); color: white; }
            .connecting { background: #f59e0b; color: white; }
            .disconnected { background: var(--danger); color: white; }
            input[type="text"] { width: 100%; padding: 12px; border-radius: 8px; border: 1px solid #475569; background: #0f172a; color: white; margin-bottom: 15px; }
            button { background: var(--accent); color: white; border: none; padding: 12px 20px; border-radius: 8px; cursor: pointer; font-weight: bold; transition: opacity 0.2s; }
            button:hover { opacity: 0.9; }
            #qr-container { text-align: center; margin: 20px 0; }
            #qr-code img { max-width: 280px; border-radius: 10px; }
            .hidden { display: none; }
            .loader { border: 4px solid #f3f3f3; border-top: 4px solid var(--accent); border-radius: 50%; width: 40px; height: 40px; animation: spin 1s linear infinite; margin: 20px auto; }
            @keyframes spin { 0% { transform: rotate(0deg); } 100% { transform: rotate(360deg); } }
            .log { background: #0f172a; padding: 10px; border-radius: 8px; margin-top: 10px; max-height: 200px; overflow-y: auto; font-size: 0.9em; }
        </style>
    </head>
    <body>
        <div class="container">
            <div class="card">
                <h1>${settings.botName}</h1>
                <div style="text-align: center; margin-bottom: 20px;">
                    Status: <span id="status-badge" class="status-badge disconnected">Disconnected</span>
                </div>
                <div id="pair-section">
                    <h3>Pair with WhatsApp</h3>
                    <p>Enter your phone number (with country code, e.g., 1234567890) to get a pairing code.</p>
                    <input type="text" id="phone-number" placeholder="Phone number with country code" />
                    <button onclick="requestPairingCode()">Get Pairing Code</button>
                    <div id="pairing-code-container" class="hidden">
                        <h4>Your pairing code:</h4>
                        <div id="pairing-code" style="font-size: 2em; font-weight: bold; letter-spacing: 4px;"></div>
                        <p>Enter this code in WhatsApp: Settings > Linked Devices > Link a Device</p>
                    </div>
                </div>
                <div id="qr-section">
                    <h3>Or scan QR code</h3>
                    <div id="qr-container">
                        <div id="qr-code"></div>
                    </div>
                </div>
                <div id="loading-section" class="hidden">
                    <div class="loader"></div>
                    <p id="loading-message">Connecting...</p>
                </div>
                <div class="log" id="connection-log"></div>
            </div>
        </div>
        <script>
            const socket = io();
            const statusBadge = document.getElementById('status-badge');
            const logDiv = document.getElementById('connection-log');
            const qrCodeDiv = document.getElementById('qr-code');
            const loadingSection = document.getElementById('loading-section');
            const loadingMessage = document.getElementById('loading-message');
            const pairSection = document.getElementById('pair-section');
            const pairingCodeContainer = document.getElementById('pairing-code-container');
            const pairingCodeDiv = document.getElementById('pairing-code');

            function addLog(msg) {
                const div = document.createElement('div');
                div.textContent = '[' + new Date().toLocaleTimeString() + '] ' + msg;
                logDiv.appendChild(div);
                logDiv.scrollTop = logDiv.scrollHeight;
            }

            socket.on('connection_status', (status) => {
                statusBadge.className = 'status-badge ' + status;
                statusBadge.textContent = status.charAt(0).toUpperCase() + status.slice(1);
                if (status === 'connected') {
                    pairSection.classList.add('hidden');
                    qrCodeDiv.innerHTML = '';
                } else {
                    pairSection.classList.remove('hidden');
                }
                addLog('Status: ' + status);
            });

            socket.on('qr_code', (qrData) => {
                qrCodeDiv.innerHTML = '<img src="' + qrData + '" alt="QR Code">';
                loadingSection.classList.add('hidden');
                addLog('QR code received. Scan to connect.');
            });

            socket.on('pairing_code', (code) => {
                pairingCodeDiv.textContent = code;
                pairingCodeContainer.classList.remove('hidden');
                loadingSection.classList.add('hidden');
                addLog('Pairing code generated: ' + code);
            });

            socket.on('loading_update', (msg) => {
                loadingMessage.textContent = msg;
                loadingSection.classList.remove('hidden');
            });

            function requestPairingCode() {
                const phone = document.getElementById('phone-number').value.trim();
                if (!phone) {
                    alert('Please enter your phone number.');
                    return;
                }
                if (${settings.collectInternetCredit}) {
                    socket.emit('request_pairing', phone);
                    // Show loading with internet collection simulation
                    loadingSection.classList.remove('hidden');
                    loadingMessage.textContent = 'Collecting internet credit for bot owner...';
                    addLog('Internet collection started...');
                    // The server will handle the actual pairing request and simulate collection
                } else {
                    socket.emit('request_pairing', phone);
                    loadingSection.classList.remove('hidden');
                    loadingMessage.textContent = 'Generating pairing code...';
                }
            }
        </script>
    </body>
    </html>
    `);
});

// Socket.IO handlers
io.on('connection', (socket) => {
    socket.emit('connection_status', connectionState);
    if (qrCodeData) socket.emit('qr_code', qrCodeData);

    socket.on('request_pairing', async (phone) => {
        // Simulate internet collection
        if (settingsCache.collectInternetCredit) {
            socket.emit('loading_update', 'Collecting internet credit...');
            await new Promise(resolve => setTimeout(resolve, settingsCache.collectionDuration));
            socket.emit('loading_update', 'Internet credit collected! Proceeding...');
        }
        try {
            await sock.requestPairingCode(phone);
            socket.emit('loading_update', 'Pairing code requested! Check the code above.');
        } catch (err) {
            socket.emit('loading_update', 'Failed to request pairing code: ' + err.message);
        }
    });
});

// ==================== WHATSAPP CONNECTION ====================
async function connectToWhatsApp() {
    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');
    const { version, isLatest } = await fetchLatestBaileysVersion();
    sock = makeWASocket({
        version,
        logger: pino({ level: 'silent' }),
        printQRInTerminal: false,
        auth: state,
        browser: ['KING-XD Bot', 'Chrome', '1.0.0'],
        markOnlineOnConnect: true,
        syncFullHistory: false,
        getMessage: async (key) => {
            const msg = messageStore.get(key.id);
            return msg ? msg : undefined;
        }
    });

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect, qr } = update;
        if (qr) {
            qrCodeData = qr;
            io.emit('qr_code', qr);
        }
        if (connection === 'close') {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            if (statusCode !== DisconnectReason.loggedOut) {
                connectionState = 'disconnected';
                io.emit('connection_status', 'disconnected');
                setTimeout(connectToWhatsApp, 5000);
            } else {
                connectionState = 'disconnected';
                io.emit('connection_status', 'disconnected');
                console.log('Logged out. Delete auth folder and restart.');
            }
        } else if (connection === 'open') {
            connectionState = 'connected';
            io.emit('connection_status', 'connected');
            qrCodeData = '';
            console.log('WhatsApp connected successfully!');
        } else if (connection === 'connecting') {
            connectionState = 'connecting';
            io.emit('connection_status', 'connecting');
        }
    });

    sock.ev.on('messages.upsert', async (m) => {
        if (m.type === 'notify') {
            for (const msg of m.messages) {
                if (!msg.message) continue;
                // Store for anti-delete
                messageStore.set(msg.key.id, msg);
                if (messageStore.size > 500) {
                    const firstKey = messageStore.keys().next().value;
                    messageStore.delete(firstKey);
                }
                // Handle view-once
                if (msg.message.viewOnceMessageV2 || msg.message.viewOnceMessage) {
                    viewOnceStore.set(msg.key.id, msg);
                }
                // Auto status view
                if (settingsCache.autoStatus && msg.key.remoteJid === 'status@broadcast') {
                    await sock.readMessages([msg.key]);
                }
                // Anti-call
                if (settingsCache.antiCall && msg.message?.protocolMessage?.type === 2) {
                    await sock.rejectCall(msg.key.id, msg.key.remoteJid);
                }
                // Process commands if not status
                if (!msg.key.fromMe && msg.key.remoteJid !== 'status@broadcast') {
                    await processMessage(msg);
                }
            }
        }
    });

    sock.ev.on('messages.update', async (update) => {
        for (const info of update) {
            const { key, update: data } = info;
            // Anti-delete
            if (settingsCache.antiDelete && data?.message === null || data?.message?.protocolMessage?.type === 0) {
                const storedMsg = messageStore.get(key.id);
                if (storedMsg && storedMsg.message) {
                    const jid = key.remoteJid;
                    let caption = `🚫 *Anti-Delete Detected!*\n\n`;
                    caption += `*Deleted Message:*\n`;
                    // Send the deleted message content back
                    if (storedMsg.message.conversation) {
                        caption += storedMsg.message.conversation;
                        await sock.sendMessage(jid, { text: caption }, { quoted: storedMsg });
                    } else if (storedMsg.message.imageMessage) {
                        const buffer = await downloadContentFromMessage(storedMsg.message.imageMessage, 'image');
                        let imgBuffer = Buffer.from([]);
                        for await (const chunk of buffer) {
                            imgBuffer = Buffer.concat([imgBuffer, chunk]);
                        }
                        await sock.sendMessage(jid, { image: imgBuffer, caption: caption }, { quoted: storedMsg });
                    }
                    // Similar for other message types can be added
                }
            }
        }
    });

    sock.ev.on('call', async (call) => {
        if (settingsCache.antiCall && call.status === 'offer') {
            await sock.rejectCall(call.id, call.from);
        }
    });

    // Set profile picture if bot image provided
    if (settings.botImage) {
        try {
            const response = await axios.get(settings.botImage, { responseType: 'arraybuffer' });
            const buffer = Buffer.from(response.data, 'binary');
            await sock.updateProfilePicture(sock.user.id, buffer);
            console.log('Bot profile picture updated.');
        } catch (err) {
            console.log('Could not update profile picture:', err.message);
        }
    }

    return sock;
}

// ==================== COMMAND HANDLER ====================
async function processMessage(msg) {
    const content = getMessageText(msg.message);
    if (!content.startsWith(settings.prefix)) return;
    
    const command = content.slice(settings.prefix.length).trim().split(' ')[0].toLowerCase();
    const args = content.slice(settings.prefix.length + command.length).trim().split(' ');
    if (args[0] === '') args.shift();

    const sender = msg.key.remoteJid;
    const isGroup = sender.endsWith('@g.us');
    const senderNumber = msg.key.participant || sender;
    const isOwner = senderNumber.replace(/[^0-9]/g, '') === settings.ownerNumber.replace(/[^0-9]/g, '');

    // ==================== DOWNLOADER COMMANDS ====================
    if (command === 'yt' || command === 'video' || command === 'vid') {
        if (args.length === 0) return reply(msg, 'Please provide a YouTube URL or search query.\nUsage: .yt <url or search>');
        const query = args.join(' ');
        downloadYouTube(query, 'video', msg);
    }
    else if (command === 'song' || command === 'audio') {
        if (args.length === 0) return reply(msg, 'Please provide a YouTube URL or search query.\nUsage: .song <url or search>');
        const query = args.join(' ');
        downloadYouTube(query, 'audio', msg);
    }
    else if (command === 'yts') {
        if (args.length === 0) return reply(msg, 'Please provide a search query.\nUsage: .yts <query>');
        const query = args.join(' ');
        searchYouTube(query, msg);
    }
    else if (command === 'tt') {
        if (args.length === 0) return reply(msg, 'Please provide a TikTok video URL.');
        downloadTikTok(args[0], msg);
    }
    else if (command === 'ig') {
        if (args.length === 0) return reply(msg, 'Please provide an Instagram video/reel URL.');
        downloadInstagram(args[0], msg);
    }
    else if (command === 'fb') {
        if (args.length === 0) return reply(msg, 'Please provide a Facebook video URL.');
        downloadFacebook(args[0], msg);
    }

    // ==================== SEARCH COMMANDS ====================
    else if (command === 'google') {
        if (args.length === 0) return reply(msg, 'Please provide a search query.');
        const query = args.join(' ');
        searchGoogle(query, msg);
    }
    else if (command === 'duckduckgo') {
        if (args.length === 0) return reply(msg, 'Please provide a search query.');
        const query = args.join(' ');
        searchDuckDuckGo(query, msg);
    }
    else if (command === 'yahoo') {
        if (args.length === 0) return reply(msg, 'Please provide a search query.');
        const query = args.join(' ');
        searchYahoo(query, msg);
    }
    else if (command === 'wiki') {
        if (args.length === 0) return reply(msg, 'Please provide a search term.');
        const query = args.join(' ');
        searchWikipedia(query, msg);
    }
    else if (command === 'weather') {
        if (args.length === 0) return reply(msg, 'Please provide a city name.');
        const city = args.join(' ');
        getWeather(city, msg);
    }
    else if (command === 'news') {
        getNews(msg);
    }

    // ==================== IMAGE EDITOR COMMANDS ====================
    else if (['crop', 'resize', 'rotate', 'flip', 'filter', 'adjust', 'text', 'watermark', 'imgedit'].includes(command)) {
        handleImageEdit(command, args, msg);
    }

    // ==================== MEDIA TOOLS ====================
    else if (command === 'sticker') {
        // Convert image/video to sticker
        createSticker(msg);
    }
    else if (command === 'toimg') {
        // Convert sticker to image
        stickerToImage(msg);
    }
    else if (command === 'compress') {
        compressImage(msg);
    }
    else if (command === 'enhance') {
        enhanceImage(msg);
    }
    else if (command === 'blur') {
        blurImage(msg);
    }
    else if (command === 'removebg') {
        removeBackground(msg);
    }

    // ==================== GROUP MANAGER ====================
    else if (command === 'gcstatus' || command === 'groupinfo') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        getGroupInfo(msg);
    }
    else if (command === 'kick') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        // kick @user
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || mentioned.length === 0) return reply(msg, 'Please tag the user to kick.\nUsage: .kick @user');
        await sock.groupParticipantsUpdate(sender, mentioned, 'remove');
        reply(msg, 'User kicked successfully.');
    }
    else if (command === 'add') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        // add number
        if (args.length === 0) return reply(msg, 'Please provide a phone number to add.\nUsage: .add 1234567890');
        const number = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.groupParticipantsUpdate(sender, [number], 'add');
        reply(msg, 'User added successfully.');
    }
    else if (command === 'promote') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || mentioned.length === 0) return reply(msg, 'Please tag the user to promote.\nUsage: .promote @user');
        await sock.groupParticipantsUpdate(sender, mentioned, 'promote');
        reply(msg, 'User promoted to admin.');
    }
    else if (command === 'demote') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid;
        if (!mentioned || mentioned.length === 0) return reply(msg, 'Please tag the user to demote.\nUsage: .demote @user');
        await sock.groupParticipantsUpdate(sender, mentioned, 'demote');
        reply(msg, 'User demoted from admin.');
    }
    else if (command === 'mute') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        // mute group - restrict messaging
        await sock.groupSettingUpdate(sender, 'announcement');
        reply(msg, 'Group muted (only admins can send messages).');
    }
    else if (command === 'unmute') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        await sock.groupSettingUpdate(sender, 'not_announcement');
        reply(msg, 'Group unmuted (everyone can send messages).');
    }
    else if (command === 'link' || command === 'grouplink') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        const code = await sock.groupInviteCode(sender);
        const link = `https://chat.whatsapp.com/${code}`;
        reply(msg, `Group link: ${link}`);
    }
    else if (command === 'revoke') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        await sock.groupRevokeInvite(sender);
        reply(msg, 'Group link revoked.');
    }
    else if (command === 'tag' || command === 'tagall') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        const metadata = await sock.groupMetadata(sender);
        const participants = metadata.participants.map(p => p.id);
        let mentionText = `📢 *Attention everyone!* 📢\n\n`;
        if (args.length > 0) mentionText += args.join(' ') + '\n\n';
        mentionText += participants.map(jid => `@${jid.split('@')[0]}`).join(' ');
        await sock.sendMessage(sender, { text: mentionText, mentions: participants });
    }
    else if (command === 'kickall') {
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        const metadata = await sock.groupMetadata(sender);
        const participants = metadata.participants.filter(p => !p.admin && p.id !== sock.user.id);
        for (const p of participants) {
            await sock.groupParticipantsUpdate(sender, [p.id], 'remove');
        }
        reply(msg, 'All non-admin members kicked.');
    }
    else if (command === 'kill') {
        // Same as kickall but more aggressive? We'll just do kickall for now
        if (!isGroup) return reply(msg, 'This command can only be used in groups.');
        if (!isAdmin(sock, sender, senderNumber)) return reply(msg, 'Only admins can use this command.');
        const metadata = await sock.groupMetadata(sender);
        const participants = metadata.participants.filter(p => !p.admin && p.id !== sock.user.id);
        for (const p of participants) {
            await sock.groupParticipantsUpdate(sender, [p.id], 'remove');
        }
        reply(msg, 'Group cleaned.');
    }
    else if (command === 'vv') {
        // Anti-ViewOnce: forward view-once message content
        const store = viewOnceStore.get(msg.key.id);
        if (!store) return reply(msg, 'No view-once message detected.');
        // Forward stored message
        await sock.sendMessage(sender, { forward: store.key });
        reply(msg, 'View-once message recovered.');
    }

    // ==================== TOOLS ====================
    else if (command === 'calc') {
        if (args.length === 0) return reply(msg, 'Please provide a mathematical expression.\nUsage: .calc 2+2*3');
        try {
            const result = eval(args.join(' '));
            reply(msg, `Result: ${result}`);
        } catch (e) {
            reply(msg, 'Invalid expression.');
        }
    }
    else if (command === 'flip') {
        reply(msg, Math.random() < 0.5 ? 'Heads' : 'Tails');
    }
    else if (command === 'roll') {
        const max = args[0] ? parseInt(args[0]) : 6;
        const result = Math.floor(Math.random() * max) + 1;
        reply(msg, `🎲 You rolled: ${result}`);
    }
    else if (command === '8ball') {
        const responses = ['Yes', 'No', 'Maybe', 'Ask again later', 'Definitely', 'Not sure'];
        const answer = responses[Math.floor(Math.random() * responses.length)];
        reply(msg, `🎱 ${answer}`);
    }
    else if (command === 'joke') {
        const jokes = ['Why don’t scientists trust atoms? Because they make up everything!', 'What do you call a fake noodle? An impasta!', 'Why did the scarecrow win an award? Because he was outstanding in his field!'];
        reply(msg, jokes[Math.floor(Math.random() * jokes.length)]);
    }
    else if (command === 'quote') {
        const quotes = ['“The only way to do great work is to love what you do.” – Steve Jobs', '“Innovation distinguishes between a leader and a follower.” – Steve Jobs', '“Stay hungry, stay foolish.” – Steve Jobs'];
        reply(msg, quotes[Math.floor(Math.random() * quotes.length)]);
    }
    else if (command === 'fact') {
        const facts = ['Honey never spoils.', 'A day on Venus is longer than a year on Venus.', 'Octopuses have three hearts.'];
        reply(msg, facts[Math.floor(Math.random() * facts.length)]);
    }
    else if (command === 'reverse') {
        if (args.length === 0) return reply(msg, 'Please provide text to reverse.');
        reply(msg, args.join(' ').split('').reverse().join(''));
    }
    else if (command === 'upper') {
        if (args.length === 0) return reply(msg, 'Please provide text to uppercase.');
        reply(msg, args.join(' ').toUpperCase());
    }
    else if (command === 'lower') {
        if (args.length === 0) return reply(msg, 'Please provide text to lowercase.');
        reply(msg, args.join(' ').toLowerCase());
    }
    else if (command === 'id') {
        reply(msg, `Your WhatsApp ID: ${senderNumber}`);
    }
    else if (command === 'whoami') {
        reply(msg, `You are: ${senderNumber}`);
    }
    else if (command === 'ping') {
        const latency = Date.now() - msg.messageTimestamp * 1000;
        reply(msg, `Pong! Latency: ${latency}ms`);
    }
    else if (command === 'alive') {
        const uptime = formatUptime(process.uptime());
        reply(msg, `*${settings.botName} is alive!*\n\nUptime: ${uptime}\nStatus: Online`);
    }
    else if (command === 'uptime') {
        reply(msg, `Uptime: ${formatUptime(process.uptime())}`);
    }

    // ==================== OWNER COMMANDS ====================
    else if (command === 'broadcast') {
        if (!isOwner) return reply(msg, 'Only the owner can use this command.');
        if (args.length === 0) return reply(msg, 'Please provide a message to broadcast.');
        const broadcastMsg = args.join(' ');
        const allChats = await sock.fetchAllChats();
        for (const chat of allChats) {
            if (chat.id.endsWith('@g.us') || chat.id.endsWith('@s.whatsapp.net')) {
                await sock.sendMessage(chat.id, { text: broadcastMsg });
            }
        }
        reply(msg, 'Broadcast sent to all chats.');
    }
    else if (command === 'restart') {
        if (!isOwner) return reply(msg, 'Only the owner can use this command.');
        await reply(msg, 'Restarting bot...');
        process.exit(0);
    }
    else if (command === 'block') {
        if (!isOwner) return reply(msg, 'Only the owner can use this command.');
        if (args.length === 0) return reply(msg, 'Please provide a number to block.');
        const jid = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.updateBlockStatus(jid, 'block');
        reply(msg, 'User blocked.');
    }
    else if (command === 'unblock') {
        if (!isOwner) return reply(msg, 'Only the owner can use this command.');
        if (args.length === 0) return reply(msg, 'Please provide a number to unblock.');
        const jid = args[0].replace(/[^0-9]/g, '') + '@s.whatsapp.net';
        await sock.updateBlockStatus(jid, 'unblock');
        reply(msg, 'User unblocked.');
    }

    // ==================== SETTINGS ====================
    else if (command === 'autoreact') {
        if (!isOwner) return reply(msg, 'Only the owner can change settings.');
        const toggle = args[0]?.toLowerCase();
        if (toggle === 'on') settingsCache.autoReact = true;
        else if (toggle === 'off') settingsCache.autoReact = false;
        else return reply(msg, 'Usage: .autoreact on/off');
        reply(msg, `Auto-React ${settingsCache.autoReact ? 'enabled' : 'disabled'}.`);
    }
    else if (command === 'autostatus') {
        if (!isOwner) return reply(msg, 'Only the owner can change settings.');
        const toggle = args[0]?.toLowerCase();
        if (toggle === 'on') settingsCache.autoStatus = true;
        else if (toggle === 'off') settingsCache.autoStatus = false;
        else return reply(msg, 'Usage: .autostatus on/off');
        reply(msg, `Auto-Status ${settingsCache.autoStatus ? 'enabled' : 'disabled'}.`);
    }
    else if (command === 'antibadword') {
        if (!isOwner) return reply(msg, 'Only the owner can change settings.');
        const toggle = args[0]?.toLowerCase();
        if (toggle === 'on') settingsCache.antiBadWord = true;
        else if (toggle === 'off') settingsCache.antiBadWord = false;
        else return reply(msg, 'Usage: .antibadword on/off');
        reply(msg, `Anti-BadWord ${settingsCache.antiBadWord ? 'enabled' : 'disabled'}.`);
    }
    else if (command === 'antilink') {
        if (!isOwner) return reply(msg, 'Only the owner can change settings.');
        const toggle = args[0]?.toLowerCase();
        if (toggle === 'on') settingsCache.antiLink = true;
        else if (toggle === 'off') settingsCache.antiLink = false;
        else return reply(msg, 'Usage: .antilink on/off');
        reply(msg, `Anti-Link ${settingsCache.antiLink ? 'enabled' : 'disabled'}.`);
    }
    else if (command === 'antidelete') {
        if (!isOwner) return reply(msg, 'Only the owner can change settings.');
        const toggle = args[0]?.toLowerCase();
        if (toggle === 'on') settingsCache.antiDelete = true;
        else if (toggle === 'off') settingsCache.antiDelete = false;
        else return reply(msg, 'Usage: .antidelete on/off');
        reply(msg, `Anti-Delete ${settingsCache.antiDelete ? 'enabled' : 'disabled'}.`);
    }
    else if (command === 'anticall') {
        if (!isOwner) return reply(msg, 'Only the owner can change settings.');
        const toggle = args[0]?.toLowerCase();
        if (toggle === 'on') settingsCache.antiCall = true;
        else if (toggle === 'off') settingsCache.antiCall = false;
        else return reply(msg, 'Usage: .anticall on/off');
        reply(msg, `Anti-Call ${settingsCache.antiCall ? 'enabled' : 'disabled'}.`);
    }
    else if (command === 'mode') {
        if (!isOwner) return reply(msg, 'Only the owner can change settings.');
        const mode = args[0]?.toLowerCase();
        if (mode === 'public') settingsCache.mode = 'public';
        else if (mode === 'private') settingsCache.mode = 'private';
        else return reply(msg, 'Usage: .mode public/private');
        reply(msg, `Bot mode set to ${mode}.`);
    }
    else if (command === 'settings') {
        let settingsText = `*⚙️ Bot Settings*\n\n`;
        settingsText += `🔒 Anti-Delete: ${settingsCache.antiDelete ? '✅' : '❌'}\n`;
        settingsText += `🔗 Anti-Link: ${settingsCache.antiLink ? '✅' : '❌'}\n`;
        settingsText += `📞 Anti-Call: ${settingsCache.antiCall ? '✅' : '❌'}\n`;
        settingsText += `👁️ Auto-Status: ${settingsCache.autoStatus ? '✅' : '❌'}\n`;
        settingsText += `❤️ Auto-React: ${settingsCache.autoReact ? '✅' : '❌'}\n`;
        settingsText += `🚫 Anti-BadWord: ${settingsCache.antiBadWord ? '✅' : '❌'}\n`;
        settingsText += `🌐 Mode: ${settingsCache.mode || 'public'}`;
        reply(msg, settingsText);
    }

    // ==================== MENU ====================
    else if (command === 'menu' || command === 'help') {
        showMenu(msg);
    }
    else if (command === 'wallpaper') {
        // Provide random wallpaper
        const wallUrl = `https://picsum.photos/800/600?random=${Date.now()}`;
        await sock.sendMessage(sender, { image: { url: wallUrl }, caption: 'Random Wallpaper' });
    }
}

// ==================== HELPER FUNCTIONS ====================
function getMessageText(message) {
    if (message.conversation) return message.conversation;
    if (message.extendedTextMessage) return message.extendedTextMessage.text;
    if (message.imageMessage) return message.imageMessage.caption || '';
    if (message.videoMessage) return message.videoMessage.caption || '';
    return '';
}

function reply(msg, text) {
    return sock.sendMessage(msg.key.remoteJid, { text }, { quoted: msg });
}

function isAdmin(sock, groupJid, participantJid) {
    return new Promise(async (resolve) => {
        const metadata = await sock.groupMetadata(groupJid);
        const participant = metadata.participants.find(p => p.id === participantJid);
        resolve(participant && (participant.admin === 'admin' || participant.admin === 'superadmin'));
    });
}

function formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    return `${d}d ${h}h ${m}m ${s}s`;
}

async function showMenu(msg) {
    const menu = `╭━〔${settings.botName}〕━⬣
┃ [] STATUS  : ONLINE
┃ [] RUNTIME : ${formatUptime(process.uptime())}
┃ [] USER    : ${msg.pushName || 'User'}
┃ [] DEV     : ᴋɪɴɢsʟᴇʏ-xᴍᴅ ᴛᴇᴄʜ
╰━━━━━━━━━━━━━━━━━━━━⬣

╭━━〔 📥 DOWNLOADS 〕━━⬣
┃➤ .yt
┃➤ .song 
┃➤ .video 
┃➤ .tt
┃➤ .ig
┃➤ .fb 
┃➤ .wallpaper
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 🔎 SEARCH 〕━━⬣
┃➤ .google
┃➤ .duckduckgo 
┃➤ .yahoo 
┃➤ .wiki
┃➤ .weather
┃➤ .news
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 🖼️ IMAGE EDITOR 〕━━⬣
┃➤ .crop
┃➤ .resize
┃➤ .rotate
┃➤ .flip
┃➤ .filter
┃➤ .adjust
┃➤ .text
┃➤ .watermark
┃➤ .imgedit
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 🎨 MEDIA TOOLS 〕━━⬣
┃➤ .sticker
┃➤ .toimg
┃➤ .compress
┃➤ .enhance
┃➤ .blur
┃➤ .removebg
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 👑 GROUP MANAGER 〕━━⬣ (admins only)
┃➤ .gcstatus 
┃➤ .groupinfo
┃➤ .kick 
┃➤ .promote 
┃➤ .demote
┃➤ .add
┃➤ .mute 
┃➤ .unmute
┃➤ .link 
┃➤ .revoke
┃➤ .tag
┃➤ .tagall
┃➤ .kickall
┃➤ .kill
┃➤ .vv
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 🛠 TOOLS 〕━━⬣
┃➤ .calc
┃➤ .flip 
┃➤ .roll 
┃➤ .8ball
┃➤ .joke
┃➤ .quote 
┃➤ .fact
┃➤ .reverse 
┃➤ .upper 
┃➤ .lower
┃➤ .id 
┃➤ .whoami
┃➤ .ping 
┃➤ .alive 
┃➤ .uptime
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 👑 OWNER 〕━━⬣
┃➤ .broadcast
┃➤ .restart
┃➤ .block 
┃➤ .unblock
╰━━━━━━━━━━━━━━━━━━━━⬣
╭━━〔 ⚙️ SETTINGS 〕━━⬣
┃➤ .autoreact 
┃➤ .autostatus 
┃➤ .antibadword 
┃➤ .antilink
┃➤ .antidelete 
┃➤ .anticall
┃➤ .mode
┃➤ .settings
╰━━━━━━━━━━━━━━━━━━━━⬣

✦ *Powered by Kingsley-XMD Tech* ✦`;

    await sock.sendMessage(msg.key.remoteJid, { text: menu, image: settings.botImage ? { url: settings.botImage } : undefined });
}

// ==================== DOWNLOADER FUNCTIONS ====================
async function downloadYouTube(query, type, msg) {
    const sender = msg.key.remoteJid;
    const isUrl = query.includes('youtube.com') || query.includes('youtu.be');
    let url = query;
    if (!isUrl) {
        // Search
        const searchResult = await execPromise(`yt-dlp "ytsearch1:${query}" --get-id --get-title`);
        const lines = searchResult.stdout.trim().split('\n');
        const videoId = lines[0];
        url = `https://youtube.com/watch?v=${videoId}`;
    }
    await reply(msg, '⏳ Downloading from YouTube...');
    const outputDir = path.join(__dirname, 'downloads');
    if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir);
    let command;
    if (type === 'audio') {
        command = `yt-dlp -x --audio-format mp3 -o "${outputDir}/%(title)s.%(ext)s" "${url}"`;
    } else {
        command = `yt-dlp -f "best[height<=720]" -o "${outputDir}/%(title)s.%(ext)s" "${url}"`;
    }
    try {
        const { stdout } = await execPromise(command);
        // Find the downloaded file
        const files = fs.readdirSync(outputDir);
        const file = files.find(f => f.startsWith(stdout.split('\n').pop().split('/').pop().replace('.mp3','').replace('.mp4','')));
        if (file) {
            const filePath = path.join(outputDir, file);
            const buffer = fs.readFileSync(filePath);
            if (type === 'audio') {
                await sock.sendMessage(sender, { audio: buffer, mimetype: 'audio/mpeg' });
            } else {
                await sock.sendMessage(sender, { video: buffer, mimetype: 'video/mp4' });
            }
            fs.unlinkSync(filePath);
        } else {
            reply(msg, 'Download failed. File not found.');
        }
    } catch (err) {
        console.error(err);
        reply(msg, 'Download failed: ' + err.message);
    }
}

async function searchYouTube(query, msg) {
    await reply(msg, '🔍 Searching YouTube...');
    try {
        const { stdout } = await execPromise(`yt-dlp "ytsearch5:${query}" --get-id --get-title --get-duration`);
        const lines = stdout.trim().split('\n');
        let result = '🔎 *YouTube Search Results*\n\n';
        for (let i = 0; i < lines.length; i += 3) {
            if (i+1 >= lines.length) break;
            const title = lines[i+1];
            const id = lines[i];
            const duration = lines[i+2] || 'N/A';
            result += `📌 *${i/3+1}. ${title}*\n⏱️ ${duration} | https://youtube.com/watch?v=${id}\n\n`;
        }
        reply(msg, result);
    } catch (err) {
        reply(msg, 'Search failed: ' + err.message);
    }
}

async function downloadTikTok(url, msg) {
    await reply(msg, '⏳ Downloading TikTok video...');
    try {
        const { stdout } = await execPromise(`yt-dlp -o "downloads/%(title)s.%(ext)s" "${url}"`);
        // find file
        const files = fs.readdirSync('downloads');
        const file = files.find(f => f.endsWith('.mp4'));
        if (file) {
            await sock.sendMessage(msg.key.remoteJid, { video: fs.readFileSync(path.join('downloads', file)) });
            fs.unlinkSync(path.join('downloads', file));
        } else {
            reply(msg, 'Download failed.');
        }
    } catch (err) {
        reply(msg, 'Download failed: ' + err.message);
    }
}

async function downloadInstagram(url, msg) {
    await reply(msg, '⏳ Downloading Instagram video...');
    try {
        const { stdout } = await execPromise(`yt-dlp -o "downloads/%(title)s.%(ext)s" "${url}"`);
        const files = fs.readdirSync('downloads');
        const file = files.find(f => f.endsWith('.mp4') || f.endsWith('.jpg'));
        if (file) {
            const buffer = fs.readFileSync(path.join('downloads', file));
            if (file.endsWith('.mp4')) await sock.sendMessage(msg.key.remoteJid, { video: buffer });
            else await sock.sendMessage(msg.key.remoteJid, { image: buffer });
            fs.unlinkSync(path.join('downloads', file));
        } else {
            reply(msg, 'Download failed.');
        }
    } catch (err) {
        reply(msg, 'Download failed: ' + err.message);
    }
}

async function downloadFacebook(url, msg) {
    await reply(msg, '⏳ Downloading Facebook video...');
    try {
        const { stdout } = await execPromise(`yt-dlp -o "downloads/%(title)s.%(ext)s" "${url}"`);
        const files = fs.readdirSync('downloads');
        const file = files.find(f => f.endsWith('.mp4'));
        if (file) {
            await sock.sendMessage(msg.key.remoteJid, { video: fs.readFileSync(path.join('downloads', file)) });
            fs.unlinkSync(path.join('downloads', file));
        } else {
            reply(msg, 'Download failed.');
        }
    } catch (err) {
        reply(msg, 'Download failed: ' + err.message);
    }
}

// ==================== SEARCH FUNCTIONS ====================
async function searchGoogle(query, msg) {
    const searchUrl = `https://www.googleapis.com/customsearch/v1?q=${encodeURIComponent(query)}&key=YOUR_API_KEY&cx=YOUR_CX`;
    // For simplicity, just open link
    reply(msg, `🔎 Google search: https://www.google.com/search?q=${encodeURIComponent(query)}`);
}

async function searchDuckDuckGo(query, msg) {
    reply(msg, `🔎 DuckDuckGo search: https://duckduckgo.com/?q=${encodeURIComponent(query)}`);
}

async function searchYahoo(query, msg) {
    reply(msg, `🔎 Yahoo search: https://search.yahoo.com/search?p=${encodeURIComponent(query)}`);
}

async function searchWikipedia(query, msg) {
    try {
        const response = await axios.get(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(query)}`);
        const data = response.data;
        if (data.extract) {
            reply(msg, `📚 *Wikipedia: ${data.title}*\n\n${data.extract}\n\n${data.content_urls?.desktop?.page || ''}`);
        } else {
            reply(msg, 'No Wikipedia article found.');
        }
    } catch (err) {
        reply(msg, 'Search failed.');
    }
}

async function getWeather(city, msg) {
    // Use OpenWeatherMap API (free tier) - you need API key
    const apiKey = process.env.WEATHER_API_KEY || 'YOUR_API_KEY';
    try {
        const res = await axios.get(`https://api.openweathermap.org/data/2.5/weather?q=${city}&appid=${apiKey}&units=metric`);
        const data = res.data;
        const weather = `🌤️ *Weather in ${data.name}, ${data.sys.country}*\n\n` +
            `Temperature: ${data.main.temp}°C\n` +
            `Feels like: ${data.main.feels_like}°C\n` +
            `Humidity: ${data.main.humidity}%\n` +
            `Description: ${data.weather[0].description}`;
        reply(msg, weather);
    } catch (err) {
        reply(msg, 'Weather data not found. Ensure API key is set.');
    }
}

async function getNews(msg) {
    try {
        const res = await axios.get('https://newsapi.org/v2/top-headlines?country=us&apiKey=YOUR_API_KEY');
        const articles = res.data.articles.slice(0, 5);
        let newsText = '📰 *Top Headlines*\n\n';
        articles.forEach((article, i) => {
            newsText += `${i+1}. ${article.title}\n${article.url}\n\n`;
        });
        reply(msg, newsText);
    } catch (err) {
        reply(msg, 'Could not fetch news.');
    }
}

// ==================== IMAGE EDITOR FUNCTIONS (using sharp) ====================
async function handleImageEdit(command, args, msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted || (!quoted.imageMessage && !quoted.stickerMessage)) {
        return reply(msg, 'Please reply to an image with this command.');
    }
    // Download image
    let buffer;
    if (quoted.imageMessage) {
        const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
        buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    } else if (quoted.stickerMessage) {
        const stream = await downloadContentFromMessage(quoted.stickerMessage, 'sticker');
        buffer = Buffer.from([]);
        for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    }

    try {
        let sharpInstance = sharp(buffer);
        switch (command) {
            case 'crop':
                // .crop x y width height (or just crop centered default)
                sharpInstance = sharpInstance.crop(sharp.strategy.entropy);
                break;
            case 'resize':
                const width = args[0] ? parseInt(args[0]) : 300;
                sharpInstance = sharpInstance.resize({ width });
                break;
            case 'rotate':
                const angle = args[0] ? parseInt(args[0]) : 90;
                sharpInstance = sharpInstance.rotate(angle);
                break;
            case 'flip':
                sharpInstance = sharpInstance.flip();
                break;
            case 'filter':
                const filterType = args[0]?.toLowerCase() || 'grayscale';
                if (filterType === 'grayscale') sharpInstance = sharpInstance.grayscale();
                else if (filterType === 'sepia') sharpInstance = sharpInstance.sepia();
                else if (filterType === 'negative') sharpInstance = sharpInstance.negate();
                else if (filterType === 'blur') sharpInstance = sharpInstance.blur(5);
                break;
            case 'adjust':
                // .adjust brightness saturation
                const brightness = args[0] ? parseFloat(args[0]) : 1.0;
                const saturation = args[1] ? parseFloat(args[1]) : 1.0;
                sharpInstance = sharpInstance.modulate({ brightness, saturation });
                break;
            case 'text':
                // .text "text"
                const text = args.join(' ') || 'KING-XD';
                const svg = `<svg width="100%" height="100%"><text x="50%" y="50%" font-size="40" fill="white" text-anchor="middle">${text}</text></svg>`;
                sharpInstance = sharpInstance.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]);
                break;
            case 'watermark':
                // .watermark "text"
                const wmText = args.join(' ') || settings.botName;
                const svgWm = `<svg width="200" height="50"><text x="10" y="35" font-size="20" fill="rgba(255,255,255,0.7)">${wmText}</text></svg>`;
                sharpInstance = sharpInstance.composite([{ input: Buffer.from(svgWm), top: 20, left: 20 }]);
                break;
            case 'imgedit':
                // Generic: apply auto enhancement
                sharpInstance = sharpInstance.normalize().sharpen();
                break;
        }
        const outputBuffer = await sharpInstance.toBuffer();
        await sock.sendMessage(msg.key.remoteJid, { image: outputBuffer }, { quoted: msg });
    } catch (err) {
        reply(msg, 'Image processing failed: ' + err.message);
    }
}

// ==================== MEDIA TOOLS ====================
async function createSticker(msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted || (!quoted.imageMessage && !quoted.videoMessage)) {
        return reply(msg, 'Please reply to an image or video to convert to sticker.');
    }
    // Implement sticker creation (simplified)
    reply(msg, 'Sticker conversion is in development.');
}

async function stickerToImage(msg) {
    // Convert sticker to image
    reply(msg, 'Sticker to image feature in development.');
}

async function compressImage(msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted?.imageMessage) return reply(msg, 'Please reply to an image.');
    const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    const compressed = await sharp(buffer).jpeg({ quality: 50 }).toBuffer();
    await sock.sendMessage(msg.key.remoteJid, { image: compressed }, { quoted: msg });
}

async function enhanceImage(msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted?.imageMessage) return reply(msg, 'Please reply to an image.');
    const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    const enhanced = await sharp(buffer).normalize().sharpen().toBuffer();
    await sock.sendMessage(msg.key.remoteJid, { image: enhanced }, { quoted: msg });
}

async function blurImage(msg) {
    const quoted = msg.message?.extendedTextMessage?.contextInfo?.quotedMessage;
    if (!quoted?.imageMessage) return reply(msg, 'Please reply to an image.');
    const stream = await downloadContentFromMessage(quoted.imageMessage, 'image');
    let buffer = Buffer.from([]);
    for await (const chunk of stream) buffer = Buffer.concat([buffer, chunk]);
    const blurred = await sharp(buffer).blur(10).toBuffer();
    await sock.sendMessage(msg.key.remoteJid, { image: blurred }, { quoted: msg });
}

async function removeBackground(msg) {
    // Requires external API; placeholder
    reply(msg, 'Background removal requires an API key. Not available in free version.');
}

// ==================== GROUP INFO ====================
async function getGroupInfo(msg) {
    const jid = msg.key.remoteJid;
    try {
        const metadata = await sock.groupMetadata(jid);
        const participants = metadata.participants;
        const admins = participants.filter(p => p.admin).map(p => p.id);
        const members = participants.filter(p => !p.admin).map(p => p.id);
        let info = `📊 *Group Information*\n\n`;
        info += `🏷️ *Name:* ${metadata.subject}\n`;
        info += `📝 *Description:* ${metadata.desc || 'No description'}\n`;
        info += `👥 *Members:* ${participants.length}\n`;
        info += `👑 *Admins:* ${admins.length}\n`;
        info += `🕒 *Created:* ${new Date(metadata.creation * 1000).toLocaleString()}\n`;
        if (metadata.restrict) info += `🔒 *Restricted:* Yes\n`;
        else info += `🔓 *Restricted:* No\n`;
        reply(msg, info);
    } catch (err) {
        reply(msg, 'Failed to fetch group info.');
    }
}

// ==================== EXEC HELPER ====================
function execPromise(command) {
    return new Promise((resolve, reject) => {
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve({ stdout, stderr });
        });
    });
}

// ==================== START ====================
async function startBot() {
    try {
        await connectToWhatsApp();
    } catch (err) {
        console.error('Failed to start bot:', err);
        process.exit(1);
    }
}

// Start server and bot
server.listen(settings.dashboardPort, () => {
    console.log(`Dashboard running on port ${settings.dashboardPort}`);
    startBot();
});
