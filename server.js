const express = require('express');
const https = require('https');
const http = require('http');
const { Server } = require('socket.io');
const os = require('os');
const path = require('path');
const fs = require('fs');
const selfsigned = require('selfsigned');

let mediasoup;
try {
  mediasoup = require('mediasoup');
} catch (e) {
  console.warn('[LAN PULSE] Mediasoup module not found, falling back to Mesh mode.');
}

const app = express();

const KEY_PATH = path.join(__dirname, 'key.pem');
const CERT_PATH = path.join(__dirname, 'cert.pem');

async function getOrCreateCertificates() {
  if (fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH)) {
    return {
      key: fs.readFileSync(KEY_PATH),
      cert: fs.readFileSync(CERT_PATH)
    };
  }

  console.log('[LAN PULSE] Generating local self-signed SSL certificates for HTTPS support...');
  const attrs = [{ name: 'commonName', value: 'LAN-Pulse-Local-Server' }];
  const pki = await selfsigned.generate(attrs, {
    days: 365,
    keySize: 2048,
    algorithm: 'sha256'
  });

  fs.writeFileSync(KEY_PATH, pki.private);
  fs.writeFileSync(CERT_PATH, pki.cert);

  return {
    key: pki.private,
    cert: pki.cert
  };
}

const PORT = process.env.PORT || 3000;
const HTTP_PORT = process.env.HTTP_PORT || 3001;

app.use(express.static(path.join(__dirname, 'public')));

function getLocalIpAddresses() {
  const interfaces = os.networkInterfaces();
  const addresses = [];
  
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        addresses.push({
          interface: name,
          address: iface.address
        });
      }
    }
  }
  return addresses;
}

app.get('/api/server-info', (req, res) => {
  const ips = getLocalIpAddresses();
  res.json({
    status: 'online',
    port: PORT,
    httpPort: HTTP_PORT,
    protocol: 'https',
    ipAddresses: ips,
    activeUsersCount: users.size,
    activeRoomsCount: rooms.size,
    sfuAvailable: !!mediasoupWorker,
    timestamp: new Date().toISOString()
  });
});

// In-Memory Storage
const users = new Map(); // socket.id -> { id, username, room, joinedAt, mediaState }
const rooms = new Map(); // roomName -> Set of socket.id

// SFU State Management
let mediasoupWorker = null;
const roomRouters = new Map(); // roomName -> router
const sfuTransports = new Map(); // transportId -> transport
const sfuProducers = new Map(); // producerId -> { producer, socketId, room, username, kind }
const sfuConsumers = new Map(); // consumerId -> { consumer, socketId, room }

const mediaCodecs = [
  {
    kind: 'audio',
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2
  },
  {
    kind: 'video',
    mimeType: 'video/VP8',
    clockRate: 90000,
    parameters: {
      'x-google-start-bitrate': 1000
    }
  },
  {
    kind: 'video',
    mimeType: 'video/H264',
    clockRate: 90000,
    parameters: {
      'packetization-mode': 1,
      'profile-level-id': '42e01f',
      'level-asymmetry-allowed': 1
    }
  }
];

async function initMediasoup() {
  if (!mediasoup) return;
  try {
    mediasoupWorker = await mediasoup.createWorker({
      rtcMinPort: 40000,
      rtcMaxPort: 49999
    });
    console.log(`[SFU] Mediasoup Worker process started (PID: ${mediasoupWorker.pid})`);
    
    mediasoupWorker.on('died', () => {
      console.error('[SFU] Mediasoup worker died, exiting...');
      process.exit(1);
    });
  } catch (err) {
    console.warn('[SFU] Could not start Mediasoup worker:', err.message);
  }
}

async function getOrCreateRoomRouter(roomName) {
  if (roomRouters.has(roomName)) {
    return roomRouters.get(roomName);
  }
  if (!mediasoupWorker) return null;

  const router = await mediasoupWorker.createRouter({ mediaCodecs });
  roomRouters.set(roomName, router);
  console.log(`[SFU] Created Mediasoup Router for room '${roomName}'`);
  return router;
}

function getUsersInRoom(roomName) {
  const roomSockets = rooms.get(roomName);
  if (!roomSockets) return [];
  
  const userList = [];
  for (const socketId of roomSockets) {
    const user = users.get(socketId);
    if (user) {
      userList.push({
        id: user.id,
        username: user.username,
        joinedAt: user.joinedAt,
        mediaState: user.mediaState
      });
    }
  }
  return userList;
}

function handleUserLeave(socket) {
  const user = users.get(socket.id);
  if (!user) return;

  const roomName = user.room;
  users.delete(socket.id);

  // Clean up SFU resources for this socket
  cleanUpSFUUser(socket.id, socket);

  if (roomName && rooms.has(roomName)) {
    const roomSet = rooms.get(roomName);
    roomSet.delete(socket.id);

    if (roomSet.size === 0) {
      rooms.delete(roomName);
      if (roomRouters.has(roomName)) {
        const router = roomRouters.get(roomName);
        router.close();
        roomRouters.delete(roomName);
      }
    } else {
      const roomUsers = getUsersInRoom(roomName);
      socket.to(roomName).emit('user-left', {
        userId: socket.id,
        username: user.username,
        users: roomUsers
      });

      socket.to(roomName).emit('system-notice', {
        type: 'leave',
        text: `${user.username} disconnected from node`,
        timestamp: new Date().toISOString()
      });
    }
  }
}

function cleanUpSFUUser(socketId, socket) {
  // Close consumers
  for (const [consumerId, consumerData] of sfuConsumers.entries()) {
    if (consumerData.socketId === socketId) {
      consumerData.consumer.close();
      sfuConsumers.delete(consumerId);
    }
  }

  // Close producers & notify room
  for (const [producerId, producerData] of sfuProducers.entries()) {
    if (producerData.socketId === socketId) {
      producerData.producer.close();
      sfuProducers.delete(producerId);

      if (producerData.room && socket) {
        socket.to(producerData.room).emit('sfu-producer-closed', {
          producerId,
          socketId
        });
      }
    }
  }

  // Close transports
  for (const [transportId, transport] of sfuTransports.entries()) {
    if (transport.appData && transport.appData.socketId === socketId) {
      transport.close();
      sfuTransports.delete(transportId);
    }
  }
}

// Start Main HTTPS & HTTP Servers
async function startApp() {
  await initMediasoup();
  const certs = await getOrCreateCertificates();
  
  const server = https.createServer(certs, app);

  const io = new Server(server, {
    maxHttpBufferSize: 1e7,
    cors: {
      origin: '*',
      methods: ['GET', 'POST']
    }
  });

  io.on('connection', (socket) => {
    console.log(`[LAN PULSE] Client connected: ${socket.id}`);

    socket.on('join-room', ({ username, room }) => {
      if (!username || !room) return;

      const sanitizedUsername = String(username).trim().substring(0, 30);
      const sanitizedRoom = String(room).trim().toLowerCase().substring(0, 30);

      if (socket.room) {
        handleUserLeave(socket);
      }

      socket.join(sanitizedRoom);
      socket.room = sanitizedRoom;
      
      const userData = {
        id: socket.id,
        username: sanitizedUsername,
        room: sanitizedRoom,
        joinedAt: new Date().toISOString(),
        mediaState: { isMuted: false, isVideoOff: false }
      };

      users.set(socket.id, userData);

      if (!rooms.has(sanitizedRoom)) {
        rooms.set(sanitizedRoom, new Set());
      }
      rooms.get(sanitizedRoom).add(socket.id);

      const roomUsers = getUsersInRoom(sanitizedRoom);

      socket.emit('room-joined', {
        room: sanitizedRoom,
        user: userData,
        users: roomUsers,
        sfuSupported: !!mediasoupWorker
      });

      socket.to(sanitizedRoom).emit('user-joined', {
        user: userData,
        users: roomUsers
      });

      io.to(sanitizedRoom).emit('system-notice', {
        type: 'join',
        text: `${sanitizedUsername} joined the node room`,
        timestamp: new Date().toISOString()
      });
    });

    socket.on('chat-message', (data) => {
      const user = users.get(socket.id);
      if (!user || !socket.room) return;

      const messageText = String(data.text || '').trim();
      if (!messageText) return;

      const messageObj = {
        id: 'msg_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
        senderId: socket.id,
        senderName: user.username,
        text: messageText,
        timestamp: new Date().toISOString()
      };

      io.to(socket.room).emit('chat-message', messageObj);
    });

    socket.on('typing', ({ isTyping }) => {
      const user = users.get(socket.id);
      if (!user || !socket.room) return;

      socket.to(socket.room).emit('user-typing', {
        userId: socket.id,
        username: user.username,
        isTyping: !!isTyping
      });
    });

    // FILE SHARING (Chunked Relay)
    socket.on('file-start', (fileMeta) => {
      const user = users.get(socket.id);
      if (!user || !socket.room) return;

      const filePayload = {
        fileId: fileMeta.fileId,
        fileName: fileMeta.fileName,
        fileSize: fileMeta.fileSize,
        fileType: fileMeta.fileType,
        totalChunks: fileMeta.totalChunks,
        senderId: socket.id,
        senderName: user.username,
        timestamp: new Date().toISOString()
      };

      socket.to(socket.room).emit('file-start', filePayload);
      socket.emit('file-start-ack', { fileId: fileMeta.fileId });
    });

    socket.on('file-chunk', (chunkData) => {
      if (!socket.room) return;
      socket.to(socket.room).emit('file-chunk', {
        fileId: chunkData.fileId,
        chunkIndex: chunkData.chunkIndex,
        totalChunks: chunkData.totalChunks,
        data: chunkData.data
      });
    });

    socket.on('file-end', ({ fileId }) => {
      if (!socket.room) return;
      socket.to(socket.room).emit('file-end', { fileId });
    });

    // 1:1 CALL SIGNALING
    socket.on('call-user', ({ targetId, offer, callType }) => {
      const caller = users.get(socket.id);
      const targetUser = users.get(targetId);

      if (!caller || !targetUser) {
        socket.emit('call-error', { message: 'Target peer is no longer connected.' });
        return;
      }

      io.to(targetId).emit('incoming-call', {
        callerId: socket.id,
        callerName: caller.username,
        offer,
        callType: callType || 'video'
      });
    });

    socket.on('answer-call', ({ targetId, answer }) => {
      io.to(targetId).emit('call-answered', {
        responderId: socket.id,
        answer
      });
    });

    socket.on('ice-candidate', ({ targetId, candidate }) => {
      io.to(targetId).emit('ice-candidate', {
        senderId: socket.id,
        candidate
      });
    });

    socket.on('reject-call', ({ targetId, reason }) => {
      const user = users.get(socket.id);
      io.to(targetId).emit('call-rejected', {
        responderId: socket.id,
        responderName: user ? user.username : 'Peer',
        reason: reason || 'Call declined'
      });
    });

    socket.on('end-call', ({ targetId }) => {
      io.to(targetId).emit('call-ended', {
        senderId: socket.id
      });
    });

    // =================================================================
    // MEDIASOUP SFU SIGNALING HANDLERS
    // =================================================================

    socket.on('sfu-get-router-capabilities', async (callback) => {
      if (!socket.room) return callback({ error: 'Not in a room' });
      const router = await getOrCreateRoomRouter(socket.room);
      if (!router) return callback({ error: 'SFU Router unavailable' });

      callback({ rtpCapabilities: router.rtpCapabilities });
    });

    socket.on('sfu-create-transport', async ({ direction }, callback) => {
      if (!socket.room) return callback({ error: 'Not in a room' });
      const router = await getOrCreateRoomRouter(socket.room);
      if (!router) return callback({ error: 'SFU Router unavailable' });

      try {
        const ips = getLocalIpAddresses();
        const announcedIp = ips.length > 0 ? ips[0].address : '127.0.0.1';

        const transport = await router.createWebRtcTransport({
          listenIps: [{ ip: '0.0.0.0', announcedIp }],
          enableUdp: true,
          enableTcp: true,
          preferUdp: true,
          appData: { socketId: socket.id, direction }
        });

        sfuTransports.set(transport.id, transport);

        callback({
          id: transport.id,
          iceParameters: transport.iceParameters,
          iceCandidates: transport.iceCandidates,
          dtlsParameters: transport.dtlsParameters
        });
      } catch (err) {
        console.error('Error creating SFU WebRtcTransport:', err);
        callback({ error: err.message });
      }
    });

    socket.on('sfu-connect-transport', async ({ transportId, dtlsParameters }, callback) => {
      const transport = sfuTransports.get(transportId);
      if (!transport) return callback({ error: 'Transport not found' });

      try {
        await transport.connect({ dtlsParameters });
        callback({ connected: true });
      } catch (err) {
        console.error('Error connecting SFU transport:', err);
        callback({ error: err.message });
      }
    });

    socket.on('sfu-produce', async ({ transportId, kind, rtpParameters }, callback) => {
      const user = users.get(socket.id);
      const transport = sfuTransports.get(transportId);
      if (!user || !transport) return callback({ error: 'Transport or User not found' });

      try {
        const producer = await transport.produce({ kind, rtpParameters });

        sfuProducers.set(producer.id, {
          producer,
          socketId: socket.id,
          room: socket.room,
          username: user.username,
          kind
        });

        // Notify other room callers about new producer
        socket.to(socket.room).emit('sfu-new-producer', {
          producerId: producer.id,
          producerSocketId: socket.id,
          username: user.username,
          kind
        });

        callback({ id: producer.id });
      } catch (err) {
        console.error('Error producing SFU stream:', err);
        callback({ error: err.message });
      }
    });

    socket.on('sfu-consume', async ({ transportId, producerId, rtpCapabilities }, callback) => {
      if (!socket.room) return callback({ error: 'Not in a room' });
      const router = await getOrCreateRoomRouter(socket.room);
      const transport = sfuTransports.get(transportId);
      const producerData = sfuProducers.get(producerId);

      if (!router || !transport || !producerData) {
        return callback({ error: 'Router, transport or producer not found' });
      }

      if (!router.canConsume({ producerId, rtpCapabilities })) {
        return callback({ error: 'Cannot consume stream' });
      }

      try {
        const consumer = await transport.consume({
          producerId,
          rtpCapabilities,
          paused: false
        });

        sfuConsumers.set(consumer.id, {
          consumer,
          socketId: socket.id,
          room: socket.room
        });

        callback({
          id: consumer.id,
          producerId,
          kind: consumer.kind,
          rtpParameters: consumer.rtpParameters,
          producerSocketId: producerData.socketId,
          producerUsername: producerData.username
        });
      } catch (err) {
        console.error('Error consuming SFU stream:', err);
        callback({ error: err.message });
      }
    });

    socket.on('sfu-get-producers', (callback) => {
      if (!socket.room) return callback({ producers: [] });

      const roomProducers = [];
      for (const [producerId, pData] of sfuProducers.entries()) {
        if (pData.room === socket.room && pData.socketId !== socket.id) {
          roomProducers.push({
            producerId,
            producerSocketId: pData.socketId,
            username: pData.username,
            kind: pData.kind
          });
        }
      }
      callback({ producers: roomProducers });
    });

    socket.on('sfu-leave', () => {
      cleanUpSFUUser(socket.id, socket);
    });

    socket.on('update-media-state', (state) => {
      const user = users.get(socket.id);
      if (!user || !socket.room) return;

      user.mediaState = {
        isMuted: !!state.isMuted,
        isVideoOff: !!state.isVideoOff
      };

      io.to(socket.room).emit('user-media-updated', {
        userId: socket.id,
        mediaState: user.mediaState
      });
    });

    socket.on('disconnect', () => {
      console.log(`[LAN PULSE] Client disconnected: ${socket.id}`);
      handleUserLeave(socket);
    });
  });

  const httpApp = express();
  httpApp.use((req, res) => {
    const host = req.headers.host ? req.headers.host.split(':')[0] : 'localhost';
    res.redirect(`https://${host}:${PORT}${req.url}`);
  });

  http.createServer(httpApp).listen(HTTP_PORT, () => {
    // HTTP redirect listener
  });

  server.listen(PORT, '0.0.0.0', () => {
    const ipAddresses = getLocalIpAddresses();
    
    console.log('\n=================================================================');
    console.log('  📡  LAN PULSE // LOCAL TEAM COMMUNICATOR (MEDIASOUP SFU ACTIVE)');
    console.log('=================================================================');
    console.log('  HTTPS Server is running and listening on port:', PORT);
    console.log('  HTTP Redirect Server listening on port:', HTTP_PORT);
    console.log('-----------------------------------------------------------------');
    console.log('  🔒  HTTPS IS REQUIRED for Camera & Mic access on other devices!');
    console.log('  ⚡  Mediasoup SFU Mode: ON (Single Transport per participant)');
    console.log('-----------------------------------------------------------------');
    console.log('  Access locally:');
    console.log(`  👉  https://localhost:${PORT}`);
    console.log('\n  Access from other devices on the same Wi-Fi / LAN:');
    
    if (ipAddresses.length === 0) {
      console.log('  ⚠️  No active network interfaces detected. Connect to Wi-Fi/LAN!');
    } else {
      ipAddresses.forEach((item) => {
        console.log(`  🌐  https://${item.address}:${PORT}  (${item.interface})`);
      });
    }
    console.log('\n  💡  First time opening in browser on other devices:');
    console.log('      Click "Advanced" -> "Proceed / Continue to site"');
    console.log('=================================================================\n');
  });
}

startApp().catch(err => {
  console.error('[LAN PULSE] Startup error:', err);
});
