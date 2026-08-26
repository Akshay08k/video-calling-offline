/**
 * LAN PULSE - Client Main Application Controller
 * Handles Chat, Presence, File Sharing, SFU Group Calls, Audio DSP, Active Speaker Detection, and Mobile Layout.
 */

class SpeakingDetector {
  constructor() {
    this.audioCtx = null;
    this.monitors = new Map(); // tileId -> { source, intervalId, silenceTimer }
  }

  monitorStream(tileId, stream) {
    if (!stream || stream.getAudioTracks().length === 0) return;

    try {
      if (!this.audioCtx) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioCtx = new AudioContext();
      }
      if (this.audioCtx.state === 'suspended') {
        this.audioCtx.resume();
      }

      this.stopMonitoring(tileId);

      const source = this.audioCtx.createMediaStreamSource(stream);
      const analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      let silenceTimer = null;

      const intervalId = setInterval(() => {
        analyser.getByteFrequencyData(dataArray);
        let sum = 0;
        for (let i = 0; i < dataArray.length; i++) {
          sum += dataArray[i];
        }
        const avg = sum / dataArray.length;

        const tileEl = document.getElementById(`tile_${tileId}`);
        if (!tileEl) return;

        if (avg > 10) { // Volume threshold for active speech
          tileEl.classList.add('speaking');
          if (silenceTimer) clearTimeout(silenceTimer);
          silenceTimer = setTimeout(() => {
            tileEl.classList.remove('speaking');
          }, 350);
        }
      }, 100);

      this.monitors.set(tileId, { source, intervalId, silenceTimer });
    } catch (e) {
      console.warn('[SpeakingDetector] Monitor error:', e);
    }
  }

  stopMonitoring(tileId) {
    if (this.monitors.has(tileId)) {
      const { source, intervalId, silenceTimer } = this.monitors.get(tileId);
      clearInterval(intervalId);
      if (silenceTimer) clearTimeout(silenceTimer);
      try { if (source) source.disconnect(); } catch (e) {}
      this.monitors.delete(tileId);

      const tileEl = document.getElementById(`tile_${tileId}`);
      if (tileEl) tileEl.classList.remove('speaking');
    }
  }

  cleanupAll() {
    for (const tileId of this.monitors.keys()) {
      this.stopMonitoring(tileId);
    }
  }
}

const speakingDetector = new SpeakingDetector();

document.addEventListener('DOMContentLoaded', () => {
  const socket = io();

  // Application State
  let currentUser = null;
  let currentRoom = null;
  let roomUsers = [];
  let typingTimeout = null;
  let isTyping = false;

  // Synthesizer & Engines
  const fileEngine = new FileTransferEngine(socket);

  // DOM Elements
  const joinModal = document.getElementById('join-modal');
  const joinForm = document.getElementById('join-form');
  const usernameInput = document.getElementById('username-input');
  const roomInput = document.getElementById('room-input');
  const modalIpList = document.getElementById('modal-ip-list');
  const presetChips = document.querySelectorAll('.preset-chip');

  const currentRoomDisplay = document.getElementById('current-room-display');
  const currentUserDisplay = document.getElementById('current-user-display');
  const headerIpValue = document.getElementById('header-ip-value');
  const btnLeaveRoom = document.getElementById('btn-leave-room');
  const btnJoinGroupCall = document.getElementById('btn-join-group-call');

  const sidebar = document.getElementById('sidebar');
  const peerListEl = document.getElementById('peer-list');
  const peerCountBadge = document.getElementById('peer-count-badge');
  const mobilePeerCount = document.getElementById('mobile-peer-count');
  const sidebarPort = document.getElementById('sidebar-port');

  const messagesThread = document.getElementById('messages-thread');
  const chatInput = document.getElementById('chat-input');
  const btnSend = document.getElementById('btn-send');
  const btnAttachFile = document.getElementById('btn-attach-file');
  const fileInput = document.getElementById('file-input');
  const dropzoneOverlay = document.getElementById('dropzone-overlay');
  const typingBar = document.getElementById('typing-bar');
  const typingText = document.getElementById('typing-text');

  // Mobile Tabs
  const tabChat = document.getElementById('tab-chat');
  const tabPeers = document.getElementById('tab-peers');
  const tabInfo = document.getElementById('tab-info');

  // Call Elements
  const callOverlay = document.getElementById('call-overlay');
  const callOverlayTitle = document.getElementById('call-overlay-title');
  const videoWorkspace = document.getElementById('call-video-workspace');

  const btnToggleMic = document.getElementById('btn-toggle-mic');
  const btnToggleCam = document.getElementById('btn-toggle-cam');
  const btnHangup = document.getElementById('btn-hangup');

  const incomingCallAlert = document.getElementById('incoming-call-alert');
  const callerNameEl = document.getElementById('caller-name');
  const callerTypeEl = document.getElementById('caller-type');
  const btnAcceptCall = document.getElementById('btn-accept-call');
  const btnDeclineCall = document.getElementById('btn-decline-call');

  // WebRTC Manager Setup with Callbacks
  const webrtcManager = new WebRTCManager(socket, {
    // 1:1 Call Callbacks
    onIncomingCall: ({ callerId, callerName, callType }) => {
      callerNameEl.textContent = callerName;
      callerTypeEl.textContent = callType === 'video' ? '📹 Incoming Video Call' : '🎤 Incoming Voice Call';
      incomingCallAlert.classList.remove('hidden');
    },

    onOutgoingCall: (targetName, callType) => {
      callOverlayTitle.textContent = `1:1 Call with ${targetName}`;
      videoWorkspace.innerHTML = '';
      callOverlay.classList.remove('hidden');
      resetControlButtonsUI();
    },

    onCallConnected: (peer) => {
      callOverlayTitle.textContent = `Connected with ${peer.username}`;
    },

    onLocalStream: (stream) => {
      let localTile = document.getElementById('tile_local');
      if (!localTile) {
        localTile = createVideoTile('local', currentUser ? `${currentUser.username} (YOU)` : 'YOU', true);
        videoWorkspace.appendChild(localTile);
      }
      updateWorkspaceTileCount();
      const videoEl = localTile.querySelector('video');
      videoEl.srcObject = stream;

      speakingDetector.monitorStream('local', stream);
    },

    onRemoteStream: (stream) => {
      let remoteTile = document.getElementById('tile_remote');
      if (!remoteTile) {
        remoteTile = createVideoTile('remote', webrtcManager.activeCallPeer ? webrtcManager.activeCallPeer.username : 'Peer', false);
        videoWorkspace.appendChild(remoteTile);
      }
      updateWorkspaceTileCount();
      const videoEl = remoteTile.querySelector('video');
      const audioEl = remoteTile.querySelector('audio');
      webrtcManager.processRemoteAudioStream(stream, audioEl);
      videoEl.srcObject = stream;

      speakingDetector.monitorStream('remote', stream);
    },

    onCallEnded: (reason) => {
      callOverlay.classList.add('hidden');
      incomingCallAlert.classList.add('hidden');
      videoWorkspace.innerHTML = '';
      speakingDetector.cleanupAll();
      updateWorkspaceTileCount();
      appendSystemNotice(`Call ended: ${reason}`);
    },

    onCallRejected: (responderName, reason) => {
      callOverlay.classList.add('hidden');
      incomingCallAlert.classList.add('hidden');
      videoWorkspace.innerHTML = '';
      speakingDetector.cleanupAll();
      updateWorkspaceTileCount();
      appendSystemNotice(`${responderName} declined call (${reason})`);
    },

    onCallError: (errMessage) => {
      callOverlay.classList.add('hidden');
      incomingCallAlert.classList.add('hidden');
      alert(`⚠️ ${errMessage}`);
    },

    // SFU Group Call Callbacks
    onGroupCallStarted: (localStream) => {
      callOverlayTitle.textContent = `Room SFU Group Call (#${currentRoom})`;
      videoWorkspace.innerHTML = '';

      // Create Local Video Tile
      const localTile = createVideoTile('local', `${currentUser.username} (YOU)`, true);
      const videoEl = localTile.querySelector('video');
      videoEl.srcObject = localStream;
      videoWorkspace.appendChild(localTile);
      updateWorkspaceTileCount();

      speakingDetector.monitorStream('local', localStream);
      callOverlay.classList.remove('hidden');
      resetControlButtonsUI();
    },

    onGroupRemoteStream: (socketId, targetName, remoteStream, kind) => {
      let tile = document.getElementById(`tile_${socketId}`);
      if (!tile) {
        tile = createVideoTile(socketId, targetName, false);
        videoWorkspace.appendChild(tile);
      }
      updateWorkspaceTileCount();
      const videoEl = tile.querySelector('video');
      const audioEl = tile.querySelector('audio');

      if (kind === 'audio') {
        webrtcManager.processRemoteAudioStream(remoteStream, audioEl);
        speakingDetector.monitorStream(socketId, remoteStream);
      } else {
        videoEl.srcObject = remoteStream;
      }
    },

    onGroupUserLeft: ({ socketId }) => {
      speakingDetector.stopMonitoring(socketId);
      const tile = document.getElementById(`tile_${socketId}`);
      if (tile) tile.remove();
      updateWorkspaceTileCount();
    },

    onGroupCallLeft: () => {
      callOverlay.classList.add('hidden');
      videoWorkspace.innerHTML = '';
      speakingDetector.cleanupAll();
      updateWorkspaceTileCount();
    },

    onUserMediaUpdated: ({ userId, mediaState }) => {
      const targetId = (userId === socket.id) ? 'local' : userId;
      
      // Update Mute Badge
      const tileBadge = document.getElementById(`mute_${targetId}`);
      if (tileBadge) {
        if (mediaState.isMuted) {
          tileBadge.classList.remove('hidden');
        } else {
          tileBadge.classList.add('hidden');
        }
      }

      // Update Video Off Avatar Visibility
      const avatarEl = document.getElementById(`avatar_${targetId}`);
      const videoEl = document.querySelector(`#tile_${targetId} video`);
      if (avatarEl && videoEl) {
        if (mediaState.isVideoOff) {
          avatarEl.classList.remove('hidden');
          videoEl.classList.add('hidden');
        } else {
          avatarEl.classList.add('hidden');
          videoEl.classList.remove('hidden');
        }
      }
    }
  });

  function updateWorkspaceTileCount() {
    const count = videoWorkspace.children.length || 1;
    videoWorkspace.setAttribute('data-count', count);
  }

  // Dynamic Square 1:1 Video Tile Generator
  function createVideoTile(id, displayName, isLocal) {
    const tile = document.createElement('div');
    tile.className = 'video-tile-card';
    tile.id = `tile_${id}`;

    const cleanName = displayName.replace(' (YOU)', '').trim();
    const initial = cleanName ? cleanName.charAt(0).toUpperCase() : '?';

    tile.innerHTML = `
      <video class="video-element ${isLocal ? 'mirror' : ''}" autoplay playsinline ${isLocal ? 'muted' : ''}></video>
      <audio autoplay ${isLocal ? 'muted' : ''}></audio>
      
      <!-- Audio-only Profile Avatar Circle with Name Below -->
      <div class="audio-only-avatar hidden" id="avatar_${id}">
        <div class="avatar-pulse-circle">${initial}</div>
        <div class="avatar-name-display">${escapeHtml(displayName)}</div>
      </div>

      <div class="video-tile-overlay-tag">
        <span class="pulse-dot"></span>
        <span>${escapeHtml(displayName)}</span>
        <span class="mute-indicator-badge hidden" id="mute_${id}">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V5a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="22"/></svg>
          <span>Muted</span>
        </span>
      </div>
    `;
    return tile;
  }

  function resetControlButtonsUI() {
    btnToggleMic.classList.remove('off');
    btnToggleCam.classList.remove('off');
    
    const micOn = document.getElementById('icon-mic-on');
    const micOff = document.getElementById('icon-mic-off');
    if (micOn && micOff) {
      micOn.classList.remove('hidden');
      micOff.classList.add('hidden');
    }

    const camOn = document.getElementById('icon-cam-on');
    const camOff = document.getElementById('icon-cam-off');
    if (camOn && camOff) {
      camOn.classList.remove('hidden');
      camOff.classList.add('hidden');
    }
  }

  // Group Call Button Listener
  btnJoinGroupCall.addEventListener('click', () => {
    if (webrtcManager.isInGroupCall) {
      webrtcManager.leaveGroupCall();
    } else {
      webrtcManager.startGroupCall();
    }
  });

  // 1. Fetch Server LAN IP Info on Startup
  fetchServerInfo();

  async function fetchServerInfo() {
    try {
      const res = await fetch('/api/server-info');
      const data = await res.json();
      
      const proto = data.protocol || 'https';
      if (data.ipAddresses && data.ipAddresses.length > 0) {
        modalIpList.innerHTML = data.ipAddresses
          .map(ip => `<div class="ip-badge">${proto}://${ip.address}:${data.port} (${ip.interface})</div>`)
          .join('');
        
        headerIpValue.textContent = `${proto}://${data.ipAddresses[0].address}:${data.port}`;
      } else {
        modalIpList.innerHTML = `<div class="ip-badge">${proto}://localhost:${data.port}</div>`;
        headerIpValue.textContent = `localhost:${data.port}`;
      }
      sidebarPort.textContent = data.port;
    } catch (e) {
      console.warn('Failed to fetch server info:', e);
      modalIpList.innerHTML = '<div class="ip-badge">https://localhost:3000</div>';
    }
  }

  // 2. Preset Chips Click Listener
  presetChips.forEach(chip => {
    chip.addEventListener('click', () => {
      roomInput.value = chip.getAttribute('data-room');
    });
  });

  // 3. Join Form Submit
  joinForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    const room = roomInput.value.trim().toLowerCase();

    if (!username || !room) return;

    if (window.soundFx) window.soundFx.init();
    socket.emit('join-room', { username, room });
  });

  // 4. Socket Room Events
  socket.on('room-joined', ({ room, user, users }) => {
    currentUser = user;
    currentRoom = room;
    roomUsers = users;

    joinModal.classList.add('hidden');
    currentRoomDisplay.textContent = `#${room}`;
    currentUserDisplay.textContent = `Callsign: ${user.username}`;
    
    renderPeerList();
    if (window.soundFx) window.soundFx.playNoticeSound();
  });

  socket.on('user-joined', ({ user, users }) => {
    roomUsers = users;
    renderPeerList();
    if (window.soundFx) window.soundFx.playNoticeSound();
  });

  socket.on('user-left', ({ userId, username, users }) => {
    roomUsers = users;
    renderPeerList();
    if (window.soundFx) window.soundFx.playNoticeSound();
  });

  socket.on('system-notice', (notice) => {
    appendSystemNotice(notice.text);
  });

  // 5. Render Peer List in Sidebar
  function renderPeerList() {
    peerCountBadge.textContent = roomUsers.length;
    mobilePeerCount.textContent = roomUsers.length;

    peerListEl.innerHTML = '';
    roomUsers.forEach(user => {
      const isSelf = user.id === socket.id;
      const li = document.createElement('li');
      li.className = 'peer-card';

      const initial = user.username.charAt(0).toUpperCase();

      li.innerHTML = `
        <div class="peer-info">
          <div class="peer-avatar ${isSelf ? 'self' : ''}">
            ${initial}
            <span class="status-indicator"></span>
          </div>
          <div class="peer-details">
            <div class="peer-name">
              ${escapeHtml(user.username)}
              ${isSelf ? '<span class="self-badge">YOU</span>' : ''}
            </div>
            <div class="peer-status-text">Online on LAN</div>
          </div>
        </div>
        ${!isSelf ? `
          <div class="peer-actions">
            <button class="btn-icon-action btn-voice-call" title="1:1 Voice Call" data-id="${user.id}" data-name="${escapeHtml(user.username)}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 3.51 3.51l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z"/></svg>
            </button>
            <button class="btn-icon-action btn-video-call" title="1:1 Video Call" data-id="${user.id}" data-name="${escapeHtml(user.username)}">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/></svg>
            </button>
          </div>
        ` : ''}
      `;

      peerListEl.appendChild(li);
    });

    document.querySelectorAll('.btn-voice-call').forEach(btn => {
      btn.onclick = () => {
        const peerId = btn.getAttribute('data-id');
        const peerName = btn.getAttribute('data-name');
        webrtcManager.startCall(peerId, peerName, 'audio');
      };
    });

    document.querySelectorAll('.btn-video-call').forEach(btn => {
      btn.onclick = () => {
        const peerId = btn.getAttribute('data-id');
        const peerName = btn.getAttribute('data-name');
        webrtcManager.startCall(peerId, peerName, 'video');
      };
    });
  }

  // 6. Messaging & Chat Input
  btnSend.addEventListener('click', sendMessage);
  chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    } else {
      handleTypingIndicator();
    }
  });

  function sendMessage() {
    const text = chatInput.value.trim();
    if (!text) return;

    socket.emit('chat-message', { text });
    chatInput.value = '';
    stopTyping();
  }

  socket.on('chat-message', (msg) => {
    appendChatMessage(msg);
    if (msg.senderId !== socket.id && window.soundFx) {
      window.soundFx.playMessageSound();
    }
  });

  function appendChatMessage(msg) {
    const isOwn = msg.senderId === socket.id;
    const timeStr = new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const initial = msg.senderName.charAt(0).toUpperCase();

    const card = document.createElement('div');
    card.className = `message-card ${isOwn ? 'own' : ''}`;

    card.innerHTML = `
      <div class="message-avatar">${initial}</div>
      <div class="message-content-wrapper">
        <div class="message-meta">
          <span class="message-sender">${escapeHtml(msg.senderName)}</span>
          <span class="message-time">${timeStr}</span>
        </div>
        <div class="message-bubble">${formatMessageText(msg.text)}</div>
      </div>
    `;

    messagesThread.appendChild(card);
    messagesThread.scrollTop = messagesThread.scrollHeight;
  }

  function appendSystemNotice(text) {
    const div = document.createElement('div');
    div.className = 'system-notice-pill';
    div.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
      <span>${escapeHtml(text)}</span>
    `;
    messagesThread.appendChild(div);
    messagesThread.scrollTop = messagesThread.scrollHeight;
  }

  // 7. Typing Indicator Logic
  function handleTypingIndicator() {
    if (!isTyping) {
      isTyping = true;
      socket.emit('typing', { isTyping: true });
    }

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      stopTyping();
    }, 2000);
  }

  function stopTyping() {
    if (isTyping) {
      isTyping = false;
      socket.emit('typing', { isTyping: false });
    }
  }

  socket.on('user-typing', ({ username, isTyping: userIsTyping }) => {
    if (userIsTyping) {
      typingText.textContent = `${username} is typing`;
      typingBar.style.visibility = 'visible';
    } else {
      typingBar.style.visibility = 'hidden';
    }
  });

  // 8. Chunked File Transfer Setup
  btnAttachFile.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleSelectedFile(e.target.files[0]);
    }
  });

  ['dragenter', 'dragover'].forEach(eventName => {
    document.body.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzoneOverlay.classList.add('active');
    }, false);
  });

  ['dragleave', 'drop'].forEach(eventName => {
    dropzoneOverlay.addEventListener(eventName, (e) => {
      e.preventDefault();
      dropzoneOverlay.classList.remove('active');
    }, false);
  });

  dropzoneOverlay.addEventListener('drop', (e) => {
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleSelectedFile(files[0]);
    }
  });

  function handleSelectedFile(file) {
    const fileCardId = `send_${Date.now()}`;
    createSendingFileCard(fileCardId, file);

    fileEngine.sendFile(
      file,
      (percent) => {
        const bar = document.getElementById(`${fileCardId}_bar`);
        if (bar) bar.style.width = `${percent}%`;
      },
      () => {
        const card = document.getElementById(fileCardId);
        if (card) {
          const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
          card.querySelector('.file-size').textContent = `${sizeMB} MB • Sent successfully`;
          card.querySelector('.progress-bar-container').style.display = 'none';
        }
      },
      (err) => {
        alert('File send failed: ' + err);
      }
    );
  }

  function createSendingFileCard(cardId, file) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    const card = document.createElement('div');
    card.className = 'message-card own';
    card.id = cardId;

    card.innerHTML = `
      <div class="message-avatar">${currentUser.username.charAt(0).toUpperCase()}</div>
      <div class="message-content-wrapper">
        <div class="message-meta">
          <span class="message-sender">${escapeHtml(currentUser.username)}</span>
          <span class="message-time">Sending file...</span>
        </div>
        <div class="file-card">
          <div class="file-header-info">
            <div class="file-icon-box">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
            </div>
            <div class="file-meta-details">
              <div class="file-name">${escapeHtml(file.name)}</div>
              <div class="file-size">${sizeMB} MB</div>
            </div>
          </div>
          <div class="progress-bar-container">
            <div class="progress-bar-fill" id="${cardId}_bar" style="width: 0%;"></div>
          </div>
        </div>
      </div>
    `;

    messagesThread.appendChild(card);
    messagesThread.scrollTop = messagesThread.scrollHeight;
  }

  fileEngine.setupReceiveListeners(
    (meta) => {
      const cardId = `rec_${meta.fileId}`;
      const sizeMB = (meta.fileSize / (1024 * 1024)).toFixed(2);
      const card = document.createElement('div');
      card.className = 'message-card';
      card.id = cardId;

      card.innerHTML = `
        <div class="message-avatar">${meta.senderName.charAt(0).toUpperCase()}</div>
        <div class="message-content-wrapper">
          <div class="message-meta">
            <span class="message-sender">${escapeHtml(meta.senderName)}</span>
            <span class="message-time">Sharing file...</span>
          </div>
          <div class="file-card">
            <div class="file-header-info">
              <div class="file-icon-box">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              </div>
              <div class="file-meta-details">
                <div class="file-name">${escapeHtml(meta.fileName)}</div>
                <div class="file-size" id="${cardId}_size">${sizeMB} MB • Receiving...</div>
              </div>
            </div>
            <div class="progress-bar-container">
              <div class="progress-bar-fill" id="${cardId}_bar" style="width: 0%;"></div>
            </div>
          </div>
        </div>
      `;

      messagesThread.appendChild(card);
      messagesThread.scrollTop = messagesThread.scrollHeight;
    },
    (fileId, percent) => {
      const bar = document.getElementById(`rec_${fileId}_bar`);
      if (bar) bar.style.width = `${percent}%`;
    },
    (fileObj) => {
      const card = document.getElementById(`rec_${fileObj.fileId}`);
      if (card) {
        const sizeMB = (fileObj.fileSize / (1024 * 1024)).toFixed(2);
        const fileCardContainer = card.querySelector('.file-card');

        const barContainer = card.querySelector('.progress-bar-container');
        if (barContainer) barContainer.remove();
        card.querySelector(`#rec_${fileObj.fileId}_size`).textContent = `${sizeMB} MB • Complete`;

        if (fileObj.fileType.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = fileObj.url;
          img.style.maxWidth = '100%';
          img.style.maxHeight = '250px';
          img.style.borderRadius = '8px';
          img.style.marginTop = '8px';
          fileCardContainer.appendChild(img);
        }

        const downloadBtn = document.createElement('a');
        downloadBtn.href = fileObj.url;
        downloadBtn.download = fileObj.fileName;
        downloadBtn.className = 'btn-download-file';
        downloadBtn.innerHTML = `
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
          <span>Download File (${sizeMB} MB)</span>
        `;
        fileCardContainer.appendChild(downloadBtn);
      }

      if (window.soundFx) window.soundFx.playNoticeSound();
    }
  );

  // 9. Call Controls Listeners & SVG Icon Toggling
  btnAcceptCall.onclick = () => {
    incomingCallAlert.classList.add('hidden');
    webrtcManager.acceptCall();
    callOverlay.classList.remove('hidden');
  };

  btnDeclineCall.onclick = () => {
    incomingCallAlert.classList.add('hidden');
    webrtcManager.rejectCall('User declined incoming call');
  };

  btnToggleMic.onclick = () => {
    const isMuted = webrtcManager.toggleMute();
    btnToggleMic.classList.toggle('off', isMuted);
    
    const iconOn = document.getElementById('icon-mic-on');
    const iconOff = document.getElementById('icon-mic-off');
    if (iconOn && iconOff) {
      iconOn.classList.toggle('hidden', isMuted);
      iconOff.classList.toggle('hidden', !isMuted);
    }

    const localMuteBadge = document.getElementById('mute_local');
    if (localMuteBadge) {
      localMuteBadge.classList.toggle('hidden', !isMuted);
    }
  };

  btnToggleCam.onclick = () => {
    const isVideoOff = webrtcManager.toggleVideo();
    btnToggleCam.classList.toggle('off', isVideoOff);

    const iconOn = document.getElementById('icon-cam-on');
    const iconOff = document.getElementById('icon-cam-off');
    if (iconOn && iconOff) {
      iconOn.classList.toggle('hidden', isVideoOff);
      iconOff.classList.toggle('hidden', !isVideoOff);
    }

    const localAvatar = document.getElementById('avatar_local');
    const localVideo = document.querySelector('#tile_local video');
    if (localAvatar && localVideo) {
      if (isVideoOff) {
        localAvatar.classList.remove('hidden');
        localVideo.classList.add('hidden');
      } else {
        localAvatar.classList.add('hidden');
        localVideo.classList.remove('hidden');
      }
    }
  };

  const btnToggleDenoise = document.getElementById('btn-toggle-denoise');
  if (btnToggleDenoise) {
    btnToggleDenoise.onclick = () => {
      const enabled = webrtcManager.toggleNoiseSuppression();
      btnToggleDenoise.classList.toggle('off', !enabled);
      btnToggleDenoise.classList.toggle('active-feature', enabled);
      btnToggleDenoise.title = enabled 
        ? 'RNNoise AI Noise Suppression (Active)' 
        : 'RNNoise AI Noise Suppression (Disabled)';
    };
  }

  btnHangup.onclick = () => {
    if (webrtcManager.isInGroupCall) {
      webrtcManager.leaveGroupCall();
    } else {
      webrtcManager.hangUp();
    }
  };

  btnLeaveRoom.onclick = () => {
    window.location.reload();
  };

  // 10. Mobile Tabs Logic
  tabChat.onclick = () => {
    tabChat.classList.add('active');
    tabPeers.classList.remove('active');
    tabInfo.classList.remove('active');
    sidebar.classList.remove('mobile-active');
  };

  tabPeers.onclick = () => {
    tabPeers.classList.add('active');
    tabChat.classList.remove('active');
    tabInfo.classList.remove('active');
    sidebar.classList.add('mobile-active');
  };

  tabInfo.onclick = () => {
    alert(`LAN Server Connection:\nAddress: ${headerIpValue.textContent}\nActive Peers: ${roomUsers.length}`);
  };

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function formatMessageText(text) {
    const escaped = escapeHtml(text);
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    return escaped.replace(urlRegex, url => `<a href="${url}" target="_blank" style="color: var(--cyan-primary); text-decoration: underline;">${url}</a>`);
  }
});
