/**
 * RNNoise WebAssembly Audio Noise Suppression Controller
 * 
 * Audio Pipeline Order:
 * Raw Microphone Stream (with browser builtin noiseSuppression: true & echoCancellation: true floor)
 *  └─> MediaStreamAudioSourceNode
 *        └─> AudioWorkletNode ('rnnoise-worklet-processor') [Runs WASM RNNoise Engine on audio thread]
 *              └─> MediaStreamAudioDestinationNode
 *                    └─> Clean Output MediaStreamTrack -> Handed to WebRTC/SFU SendTransport.
 */

class RNNoiseEngine {
  constructor() {
    this.audioCtx = null;
    this.sourceNode = null;
    this.workletNode = null;
    this.destinationNode = null;
    this.isInitialized = false;
    this.isEnabled = true; // On by default
    this.processedStream = null;
    this.rawStream = null;
  }

  async init() {
    if (this.isInitialized) return true;

    try {
      const AudioContext = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContext({ sampleRate: 48000 });

      if (this.audioCtx.state === 'suspended') {
        await this.audioCtx.resume();
      }

      // 1. Fetch WASM Binary
      const wasmRes = await fetch('/rnnoise/rnnoise.wasm');
      if (!wasmRes.ok) {
        throw new Error(`Failed to fetch rnnoise.wasm (Status ${wasmRes.status})`);
      }
      const wasmBinary = await wasmRes.arrayBuffer();

      // 2. Add AudioWorklet Module
      await this.audioCtx.audioWorklet.addModule('/js/rnnoise-worklet.js');

      // 3. Create AudioWorkletNode
      this.workletNode = new AudioWorkletNode(this.audioCtx, 'rnnoise-worklet-processor');

      // 4. Send WASM Binary to Worklet
      const readyPromise = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('WASM Worklet Init Timeout')), 5000);
        this.workletNode.port.onmessage = (e) => {
          if (e.data.type === 'WASM_READY') {
            clearTimeout(timeout);
            resolve(true);
          } else if (e.data.type === 'WASM_ERROR') {
            clearTimeout(timeout);
            reject(new Error(e.data.error));
          }
        };
      });

      this.workletNode.port.postMessage({ type: 'INIT_WASM', wasmBinary }, [wasmBinary]);
      await readyPromise;

      this.isInitialized = true;
      console.log('[RNNoiseEngine] RNNoise WASM AudioWorklet initialized successfully.');
      return true;
    } catch (err) {
      console.warn('[RNNoiseEngine] Failed to initialize WASM AudioWorklet. Falling back to browser built-in suppression:', err);
      this.isInitialized = false;
      return false;
    }
  }

  async processStream(rawStream) {
    this.rawStream = rawStream;

    // If init fails, return raw mic stream directly (fallback path)
    const success = await this.init();
    if (!success || !this.workletNode || !this.audioCtx) {
      console.warn('[RNNoiseEngine] Returning raw stream with browser built-in noise suppression fallback.');
      return rawStream;
    }

    try {
      this.cleanupNodes();

      const audioTrack = rawStream.getAudioTracks()[0];
      if (!audioTrack) return rawStream;

      this.sourceNode = this.audioCtx.createMediaStreamSource(rawStream);
      this.destinationNode = this.audioCtx.createMediaStreamDestination();

      this.sourceNode.connect(this.workletNode);
      this.workletNode.connect(this.destinationNode);

      const processedTrack = this.destinationNode.stream.getAudioTracks()[0];

      // Combine video tracks (if any) with the clean audio track
      const tracks = [...rawStream.getVideoTracks(), processedTrack];
      this.processedStream = new MediaStream(tracks);

      return this.processedStream;
    } catch (e) {
      console.error('[RNNoiseEngine] Stream processing error, falling back to raw stream:', e);
      return rawStream;
    }
  }

  toggle(enable) {
    this.isEnabled = enable;
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'TOGGLE', enabled: enable });
    }
    console.log(`[RNNoiseEngine] RNNoise Suppression toggled: ${enable ? 'ON' : 'OFF'}`);
    return this.isEnabled;
  }

  getProcessedAudioTrack() {
    if (this.processedStream && this.isEnabled) {
      return this.processedStream.getAudioTracks()[0];
    }
    if (this.rawStream) {
      return this.rawStream.getAudioTracks()[0];
    }
    return null;
  }

  cleanupNodes() {
    try {
      if (this.sourceNode) this.sourceNode.disconnect();
      if (this.destinationNode) this.destinationNode.disconnect();
    } catch (e) {}
  }

  destroy() {
    this.cleanupNodes();
    if (this.audioCtx) {
      this.audioCtx.close();
      this.audioCtx = null;
    }
    this.isInitialized = false;
  }
}

// Global Singleton Instance
window.rnnoiseEngine = new RNNoiseEngine();
