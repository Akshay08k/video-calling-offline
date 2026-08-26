/**
 * WebRTC Calling Controller (1:1 & Mediasoup SFU Group Calling with On-Device Background Blur)
 */
class WebRTCManager {
  constructor(socket, uiCallbacks) {
    this.socket = socket;
    this.ui = uiCallbacks || {};
    
    // 1:1 Call State
    this.peerConnection = null;
    this.activeCallPeer = null;
    
    // SFU Group Call State
    this.sfuDevice = null;
    this.sendTransport = null;
    this.recvTransport = null;
    this.audioProducer = null;
    this.videoProducer = null;
    this.consumers = new Map(); // consumerId -> Consumer
    this.isInGroupCall = false;

    this.localStream = null;
    this.rawVideoTrack = null;
    this.audioContext = null;
    this.isMuted = false;
    this.isVideoOff = false;

    this.peerConfig = {
      iceServers: []
    };

    this.setupSocketListeners();
  }

  setupSocketListeners() {
    // 1:1 CALL LISTENERS
    this.socket.on('incoming-call', async ({ callerId, callerName, offer, callType }) => {
      if (this.peerConnection || this.isInGroupCall) {
        this.socket.emit('reject-call', { targetId: callerId, reason: 'User is on another call' });
        return;
      }

      this.activeCallPeer = { id: callerId, username: callerName };
      this.callType = callType;
      this.pendingOffer = offer;

      if (window.soundFx) window.soundFx.startRingtone();
      if (this.ui.onIncomingCall) {
        this.ui.onIncomingCall({ callerId, callerName, callType });
      }
    });

    this.socket.on('call-answered', async ({ responderId, answer }) => {
      if (window.soundFx) window.soundFx.stopRingtone();
      if (this.peerConnection && answer) {
        try {
          await this.peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
          if (this.ui.onCallConnected) this.ui.onCallConnected(this.activeCallPeer);
        } catch (e) {
          console.error('Error setting remote description:', e);
        }
      }
    });

    this.socket.on('ice-candidate', async ({ senderId, candidate }) => {
      if (this.peerConnection && candidate) {
        try {
          await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (e) {
          console.error('Error adding ICE candidate:', e);
        }
      }
    });

    this.socket.on('call-rejected', ({ responderName, reason }) => {
      if (window.soundFx) window.soundFx.stopRingtone();
      this.cleanup1v1Call();
      if (this.ui.onCallRejected) this.ui.onCallRejected(responderName, reason);
    });

    this.socket.on('call-ended', () => {
      if (window.soundFx) window.soundFx.stopRingtone();
      this.cleanup1v1Call();
      if (this.ui.onCallEnded) this.ui.onCallEnded('Peer ended the call');
    });

    // MEDIASOUP SFU EVENT LISTENERS
    this.socket.on('sfu-new-producer', async ({ producerId, producerSocketId, username, kind }) => {
      if (!this.isInGroupCall || !this.recvTransport) return;
      await this.consumeProducer(producerId, username);
    });

    this.socket.on('sfu-producer-closed', ({ producerId, socketId }) => {
      for (const [consumerId, consumer] of this.consumers.entries()) {
        if (consumer.producerId === producerId) {
          consumer.close();
          this.consumers.delete(consumerId);
          if (this.ui.onGroupUserLeft) {
            this.ui.onGroupUserLeft({ socketId, producerId });
          }
          break;
        }
      }
    });

    this.socket.on('user-media-updated', ({ userId, mediaState }) => {
      if (this.ui.onUserMediaUpdated) {
        this.ui.onUserMediaUpdated({ userId, mediaState });
      }
    });
  }

  checkMediaSupport() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      const isHttp = window.location.protocol === 'http:';
      if (isHttp && window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1') {
        const httpsUrl = `https://${window.location.hostname}:${window.location.port || 3000}`;
        return {
          supported: false,
          reason: `Camera/Microphone permissions require HTTPS on network IP addresses.\n\nPlease open:\n👉 ${httpsUrl}`
        };
      }
      return {
        supported: false,
        reason: 'Camera/Microphone API is not supported in this browser environment.'
      };
    }
    return { supported: true };
  }

  async getEnhancedUserMedia(video = true) {
    let rawStream = null;

    // Tier 1: Primary media request with video constraints
    try {
      rawStream = await navigator.mediaDevices.getUserMedia({
        video: video ? { width: { ideal: 640 }, height: { ideal: 480 } } : false,
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
      });
    } catch (e1) {
      console.warn('[WebRTC] Primary getUserMedia failed:', e1);

      // Tier 2: Basic media request fallback
      try {
        rawStream = await navigator.mediaDevices.getUserMedia({
          video: video,
          audio: true
        });
      } catch (e2) {
        console.warn('[WebRTC] Basic getUserMedia failed:', e2);

        // Tier 3: If camera is locked/in-use by another app, fallback to Audio-Only
        if (video) {
          try {
            console.log('[WebRTC] Camera locked or unavailable, falling back to audio-only stream...');
            rawStream = await navigator.mediaDevices.getUserMedia({
              video: false,
              audio: true
            });
            this.isVideoOff = true; // Set video state to OFF so avatar renders
          } catch (e3) {
            console.error('[WebRTC] Audio-only fallback also failed:', e3);
            const msg = (e3.name === 'NotAllowedError' || e3.name === 'PermissionDeniedError')
              ? 'Microphone/Camera permission denied. Please allow microphone permissions in browser site settings.'
              : `Microphone error: ${e3.name || e3.message}`;
            throw new Error(msg);
          }
        } else {
          const msg = (e2.name === 'NotAllowedError' || e2.name === 'PermissionDeniedError')
            ? 'Microphone permission denied. Please allow microphone permissions in browser site settings.'
            : `Microphone error: ${e2.name || e2.message}`;
          throw new Error(msg);
        }
      }
    }

    // Tier 4: Safely pipe audio through RNNoise WASM AudioWorklet
    if (window.rnnoiseEngine && rawStream && rawStream.getAudioTracks().length > 0) {
      try {
        return await window.rnnoiseEngine.processStream(rawStream);
      } catch (errEngine) {
        console.warn('[WebRTC] RNNoise pipeline error, proceeding with raw stream:', errEngine);
        return rawStream;
      }
    }
    return rawStream;
  }

  toggleNoiseSuppression() {
    if (!window.rnnoiseEngine) return true;

    const enabled = window.rnnoiseEngine.toggle(!window.rnnoiseEngine.isEnabled);

    if (this.audioProducer) {
      const newTrack = window.rnnoiseEngine.getProcessedAudioTrack();
      if (newTrack) {
        this.audioProducer.replaceTrack({ track: newTrack }).catch(e => {
          console.warn('[WebRTC] Failed to replace track on audio producer:', e);
        });
      }
    }
    return enabled;
  }

  processRemoteAudioStream(remoteStream, audioMediaElement) {
    try {
      if (!this.audioContext) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        this.audioContext = new AudioContext();
      }
      if (this.audioContext.state === 'suspended') {
        this.audioContext.resume();
      }

      const source = this.audioContext.createMediaStreamSource(remoteStream);

      const highPass = this.audioContext.createBiquadFilter();
      highPass.type = 'highpass';
      highPass.frequency.setValueAtTime(85, this.audioContext.currentTime);

      const lowPass = this.audioContext.createBiquadFilter();
      lowPass.type = 'lowpass';
      lowPass.frequency.setValueAtTime(7200, this.audioContext.currentTime);

      const presenceFilter = this.audioContext.createBiquadFilter();
      presenceFilter.type = 'peaking';
      presenceFilter.frequency.setValueAtTime(1800, this.audioContext.currentTime);
      presenceFilter.Q.setValueAtTime(1.0, this.audioContext.currentTime);
      presenceFilter.gain.setValueAtTime(3.5, this.audioContext.currentTime);

      const compressor = this.audioContext.createDynamicsCompressor();
      compressor.threshold.setValueAtTime(-32, this.audioContext.currentTime);
      compressor.knee.setValueAtTime(25, this.audioContext.currentTime);
      compressor.ratio.setValueAtTime(6, this.audioContext.currentTime);
      compressor.attack.setValueAtTime(0.005, this.audioContext.currentTime);
      compressor.release.setValueAtTime(0.2, this.audioContext.currentTime);

      source.connect(highPass);
      highPass.connect(lowPass);
      lowPass.connect(presenceFilter);
      presenceFilter.connect(compressor);
      compressor.connect(this.audioContext.destination);

      audioMediaElement.srcObject = remoteStream;
      audioMediaElement.volume = 1.0;
    } catch (e) {
      console.warn('Audio DSP processing fallback:', e);
      audioMediaElement.srcObject = remoteStream;
    }
  }

  // =================================================================
  // MEDIASOUP SFU GROUP CALLING
  // =================================================================

  async startGroupCall() {
    if (this.isInGroupCall || this.peerConnection) return;

    const support = this.checkMediaSupport();
    if (!support.supported) {
      if (this.ui.onCallError) this.ui.onCallError(support.reason);
      return;
    }

    try {
      this.localStream = await this.getEnhancedUserMedia(true);
      this.rawVideoTrack = this.localStream.getVideoTracks()[0];
      this.isInGroupCall = true;
      this.isMuted = false;
      this.isVideoOff = false;

      if (this.ui.onGroupCallStarted) this.ui.onGroupCallStarted(this.localStream);

      // Check Mediasoup Client Library
      if (!window.mediasoupClient) {
        console.warn('Mediasoup client bundle missing, using mesh fallback.');
        this.socket.emit('join-group-call');
        return;
      }

      // 1. Get SFU Router Capabilities
      const routerCapabilities = await new Promise((resolve) => {
        this.socket.emit('sfu-get-router-capabilities', (data) => resolve(data.rtpCapabilities));
      });

      // 2. Initialize Mediasoup Device
      this.sfuDevice = new window.mediasoupClient.Device();
      await this.sfuDevice.load({ routerRtpCapabilities: routerCapabilities });

      // 3. Create Send Transport (Upload stream once to SFU)
      const sendTransportParams = await new Promise((resolve) => {
        this.socket.emit('sfu-create-transport', { direction: 'send' }, resolve);
      });

      this.sendTransport = this.sfuDevice.createSendTransport(sendTransportParams);

      this.sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        this.socket.emit('sfu-connect-transport', {
          transportId: this.sendTransport.id,
          dtlsParameters
        }, (res) => {
          if (res && res.error) errback(new Error(res.error));
          else callback();
        });
      });

      this.sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
        this.socket.emit('sfu-produce', {
          transportId: this.sendTransport.id,
          kind,
          rtpParameters
        }, (res) => {
          if (res && res.error) errback(new Error(res.error));
          else callback({ id: res.id });
        });
      });

      // Produce Audio & Video
      const audioTrack = this.localStream.getAudioTracks()[0];
      const videoTrack = this.localStream.getVideoTracks()[0];

      if (audioTrack) {
        this.audioProducer = await this.sendTransport.produce({ track: audioTrack });
      }
      if (videoTrack) {
        this.videoProducer = await this.sendTransport.produce({ track: videoTrack });
      }

      // 4. Create Recv Transport (Download streams from SFU)
      const recvTransportParams = await new Promise((resolve) => {
        this.socket.emit('sfu-create-transport', { direction: 'recv' }, resolve);
      });

      this.recvTransport = this.sfuDevice.createRecvTransport(recvTransportParams);

      this.recvTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
        this.socket.emit('sfu-connect-transport', {
          transportId: this.recvTransport.id,
          dtlsParameters
        }, (res) => {
          if (res && res.error) errback(new Error(res.error));
          else callback();
        });
      });

      // 5. Query and consume existing room producers
      this.socket.emit('sfu-get-producers', async ({ producers }) => {
        for (const p of producers) {
          await this.consumeProducer(p.producerId, p.username);
        }
      });

    } catch (err) {
      console.error('Failed to start SFU group call:', err);
      this.leaveGroupCall();
      if (this.ui.onCallError) {
        this.ui.onCallError(`SFU Group call failed: ${err.message}`);
      }
    }
  }

  async consumeProducer(producerId, username) {
    if (!this.recvTransport || !this.sfuDevice) return;

    const consumerParams = await new Promise((resolve) => {
      this.socket.emit('sfu-consume', {
        transportId: this.recvTransport.id,
        producerId,
        rtpCapabilities: this.sfuDevice.rtpCapabilities
      }, resolve);
    });

    if (consumerParams.error) {
      console.warn('Cannot consume producer:', consumerParams.error);
      return;
    }

    const consumer = await this.recvTransport.consume({
      id: consumerParams.id,
      producerId: consumerParams.producerId,
      kind: consumerParams.kind,
      rtpParameters: consumerParams.rtpParameters
    });

    this.consumers.set(consumer.id, consumer);

    const stream = new MediaStream([consumer.track]);

    if (this.ui.onGroupRemoteStream) {
      this.ui.onGroupRemoteStream(consumerParams.producerSocketId, username, stream, consumerParams.kind);
    }
  }

  leaveGroupCall() {
    if (!this.isInGroupCall) return;

    this.socket.emit('sfu-leave');

    if (this.audioProducer) {
      this.audioProducer.close();
      this.audioProducer = null;
    }
    if (this.videoProducer) {
      this.videoProducer.close();
      this.videoProducer = null;
    }
    if (this.sendTransport) {
      this.sendTransport.close();
      this.sendTransport = null;
    }
    if (this.recvTransport) {
      this.recvTransport.close();
      this.recvTransport = null;
    }

    this.consumers.forEach((c) => c.close());
    this.consumers.clear();

    if (this.localStream) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }

    this.isInGroupCall = false;
    if (this.ui.onGroupCallLeft) this.ui.onGroupCallLeft();
  }

  // =================================================================
  // 1:1 CALL METHODS (UNCHANGED)
  // =================================================================

  async startCall(targetId, targetName, callType = 'video') {
    if (this.peerConnection || this.isInGroupCall) return;

    const support = this.checkMediaSupport();
    if (!support.supported) {
      if (this.ui.onCallError) this.ui.onCallError(support.reason);
      return;
    }

    this.activeCallPeer = { id: targetId, username: targetName };
    this.callType = callType;
    this.isMuted = false;
    this.isVideoOff = callType === 'audio';

    try {
      this.localStream = await this.getEnhancedUserMedia(callType === 'video');
      this.rawVideoTrack = this.localStream.getVideoTracks()[0];

      if (this.ui.onLocalStream) this.ui.onLocalStream(this.localStream);

      this.init1v1PeerConnection(targetId);

      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      const offer = await this.peerConnection.createOffer();
      await this.peerConnection.setLocalDescription(offer);

      this.socket.emit('call-user', { targetId, offer, callType });

      if (window.soundFx) window.soundFx.startRingtone();
      if (this.ui.onOutgoingCall) this.ui.onOutgoingCall(targetName, callType);

    } catch (err) {
      console.error('Failed to access media devices:', err);
      this.cleanup1v1Call();
      if (this.ui.onCallError) {
        this.ui.onCallError(`Media access denied: ${err.message || 'Microphone/Camera rejected'}`);
      }
    }
  }

  async acceptCall() {
    if (window.soundFx) window.soundFx.stopRingtone();
    if (!this.activeCallPeer || !this.pendingOffer) return;

    try {
      this.localStream = await this.getEnhancedUserMedia(this.callType === 'video');
      this.rawVideoTrack = this.localStream.getVideoTracks()[0];

      if (this.ui.onLocalStream) this.ui.onLocalStream(this.localStream);

      this.init1v1PeerConnection(this.activeCallPeer.id);

      this.localStream.getTracks().forEach(track => {
        this.peerConnection.addTrack(track, this.localStream);
      });

      await this.peerConnection.setRemoteDescription(new RTCSessionDescription(this.pendingOffer));

      const answer = await this.peerConnection.createAnswer();
      await this.peerConnection.setLocalDescription(answer);

      this.socket.emit('answer-call', {
        targetId: this.activeCallPeer.id,
        answer
      });

      this.pendingOffer = null;
      if (this.ui.onCallConnected) this.ui.onCallConnected(this.activeCallPeer);

    } catch (err) {
      console.error('Failed to accept call:', err);
      this.rejectCall('Failed to access camera/microphone');
    }
  }

  rejectCall(reason = 'Call declined') {
    if (window.soundFx) window.soundFx.stopRingtone();
    if (this.activeCallPeer) {
      this.socket.emit('reject-call', { targetId: this.activeCallPeer.id, reason });
    }
    this.cleanup1v1Call();
  }

  hangUp() {
    if (window.soundFx) window.soundFx.stopRingtone();
    if (this.activeCallPeer) {
      this.socket.emit('end-call', { targetId: this.activeCallPeer.id });
    }
    this.cleanup1v1Call();
    if (this.ui.onCallEnded) this.ui.onCallEnded('Call ended');
  }

  init1v1PeerConnection(targetId) {
    this.peerConnection = new RTCPeerConnection(this.peerConfig);

    this.peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        this.socket.emit('ice-candidate', { targetId, candidate: event.candidate });
      }
    };

    this.remoteStream = new MediaStream();
    this.peerConnection.ontrack = (event) => {
      event.streams[0].getTracks().forEach(track => {
        this.remoteStream.addTrack(track);
      });
      if (this.ui.onRemoteStream) this.ui.onRemoteStream(this.remoteStream);
    };

    this.peerConnection.onconnectionstatechange = () => {
      const state = this.peerConnection.connectionState;
      if (state === 'disconnected' || state === 'failed' || state === 'closed') {
        this.cleanup1v1Call();
        if (this.ui.onCallEnded) this.ui.onCallEnded(`Connection ${state}`);
      }
    };
  }

  cleanup1v1Call() {
    if (this.localStream && !this.isInGroupCall) {
      this.localStream.getTracks().forEach(track => track.stop());
      this.localStream = null;
    }
    if (this.peerConnection) {
      this.peerConnection.close();
      this.peerConnection = null;
    }
    this.remoteStream = null;
    this.activeCallPeer = null;
    this.pendingOffer = null;
    this.isMuted = false;
    this.isVideoOff = false;
  }

  toggleMute() {
    if (!this.localStream) return this.isMuted;

    const audioTrack = this.localStream.getAudioTracks()[0];
    if (audioTrack) {
      audioTrack.enabled = !audioTrack.enabled;
      this.isMuted = !audioTrack.enabled;

      this.socket.emit('update-media-state', {
        isMuted: this.isMuted,
        isVideoOff: this.isVideoOff
      });
    }
    return this.isMuted;
  }

  toggleVideo() {
    if (!this.localStream) return this.isVideoOff;

    const videoTrack = this.localStream.getVideoTracks()[0];
    if (videoTrack) {
      videoTrack.enabled = !videoTrack.enabled;
      this.isVideoOff = !videoTrack.enabled;

      this.socket.emit('update-media-state', {
        isMuted: this.isMuted,
        isVideoOff: this.isVideoOff
      });
    }
    return this.isVideoOff;
  }
}

window.WebRTCManager = WebRTCManager;
