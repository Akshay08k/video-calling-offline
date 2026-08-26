/**
 * RNNoise WebAssembly AudioWorklet Processor
 * Runs on the Web Audio rendering thread for real-time, low-latency background noise suppression.
 * 
 * High-Performance Zero-Allocation Circular FIFO Buffer Architecture:
 * - Eliminates phase jumps, index wrapping bugs, and grinding/hissing audio artifacts.
 * - Uses pre-allocated TypedArray circular buffers to prevent Javascript Garbage Collection (GC) pauses.
 */

class RingBuffer {
  constructor(capacity = 8192) {
    this.buffer = new Float32Array(capacity);
    this.capacity = capacity;
    this.readIdx = 0;
    this.writeIdx = 0;
    this.size = 0;
  }

  push(value) {
    if (this.size >= this.capacity) return false;
    this.buffer[this.writeIdx] = value;
    this.writeIdx = (this.writeIdx + 1) % this.capacity;
    this.size++;
    return true;
  }

  pop() {
    if (this.size === 0) return 0;
    const val = this.buffer[this.readIdx];
    this.readIdx = (this.readIdx + 1) % this.capacity;
    this.size--;
    return val;
  }

  clear() {
    this.readIdx = 0;
    this.writeIdx = 0;
    this.size = 0;
  }
}

class RNNoiseWorkletProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.enabled = true;
    this.wasmLoaded = false;

    // RNNoise requires exactly 480 samples per frame (10ms @ 48kHz)
    this.FRAME_SIZE = 480;

    // Pre-allocated circular ring buffers for zero-GC audio streaming
    this.inputQueue = new RingBuffer(8192);
    this.outputQueue = new RingBuffer(8192);

    // Pre-allocated frame buffers
    this.pcmInFrame = new Float32Array(this.FRAME_SIZE);
    this.pcmOutFrame = new Float32Array(this.FRAME_SIZE);

    // WASM handles & memory pointers
    this.rnnoiseState = null;
    this.wasmInPtr = null;
    this.wasmOutPtr = null;
    this.wasmMemory = null;

    this.port.onmessage = (event) => {
      if (event.data.type === 'INIT_WASM') {
        this.initWasm(event.data.wasmBinary);
      } else if (event.data.type === 'TOGGLE') {
        this.enabled = event.data.enabled;
        if (!this.enabled) {
          this.inputQueue.clear();
          this.outputQueue.clear();
        }
      }
    };
  }

  async initWasm(wasmBinary) {
    try {
      const memory = new WebAssembly.Memory({ initial: 256, maximum: 512 });

      const importObject = {
        env: {
          memory: memory,
          abort: (err) => console.error('[RNNoise Worklet] WASM Abort:', err),
          _emscripten_memcpy_big: (dest, src, num) => {
            new Uint8Array(memory.buffer).copyWithin(dest, src, src + num);
          },
          _emscripten_resize_heap: () => false
        },
        a: {
          b: (dest, src, num) => new Uint8Array(memory.buffer).copyWithin(dest, src, src + num),
          a: () => false
        }
      };

      const { instance } = await WebAssembly.instantiate(wasmBinary, importObject);
      const exports = instance.exports;

      // Extract RNNoise C functions
      this.wasmInit = exports.e || exports._rnnoise_init;
      this.wasmCreate = exports.f || exports._rnnoise_create;
      this.wasmProcess = exports.j || exports._rnnoise_process_frame;
      this.wasmDestroy = exports.h || exports._rnnoise_destroy;
      this.wasmMalloc = exports.g || exports._malloc;
      this.wasmFree = exports.i || exports._free;

      if (exports.d) exports.d(); // Run constructors
      if (this.wasmInit) this.wasmInit();

      this.rnnoiseState = this.wasmCreate(0);
      this.wasmInPtr = this.wasmMalloc(this.FRAME_SIZE * 4);
      this.wasmOutPtr = this.wasmMalloc(this.FRAME_SIZE * 4);
      this.wasmMemory = memory;

      this.wasmLoaded = true;
      this.port.postMessage({ type: 'WASM_READY' });
    } catch (e) {
      console.warn('[RNNoise Worklet] WASM Init Error, falling back to bypass:', e);
      this.wasmLoaded = false;
      this.port.postMessage({ type: 'WASM_ERROR', error: e.message });
    }
  }

  processFrame(inFrame, outFrame) {
    if (!this.wasmLoaded || !this.rnnoiseState || !this.wasmMemory) return false;

    try {
      const heapF32 = new Float32Array(this.wasmMemory.buffer);
      const inOffset = this.wasmInPtr / 4;
      const outOffset = this.wasmOutPtr / 4;

      // RNNoise expects float samples scaled to int16 PCM range [-32768.0, 32767.0]
      for (let i = 0; i < this.FRAME_SIZE; i++) {
        heapF32[inOffset + i] = inFrame[i] * 32768.0;
      }

      this.wasmProcess(this.rnnoiseState, this.wasmOutPtr, this.wasmInPtr);

      const heapF32Out = new Float32Array(this.wasmMemory.buffer);
      for (let i = 0; i < this.FRAME_SIZE; i++) {
        // Unscale back to [-1.0, 1.0] float range with soft clipping protection
        const val = heapF32Out[outOffset + i] / 32768.0;
        outFrame[i] = Math.max(-1.0, Math.min(1.0, val));
      }
      return true;
    } catch (e) {
      console.warn('[RNNoise Worklet] Process frame error:', e);
      return false;
    }
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];

    if (!input || !input[0] || !output || !output[0]) return true;

    const inputChannel = input[0];
    const outputChannel = output[0];
    const quantumSize = inputChannel.length; // 128 samples quantum

    // If noise suppression is toggled OFF or WASM failed, pass raw mic audio through
    if (!this.enabled || !this.wasmLoaded) {
      outputChannel.set(inputChannel);
      return true;
    }

    // 1. Push incoming 128 samples into input circular ring buffer
    for (let i = 0; i < quantumSize; i++) {
      this.inputQueue.push(inputChannel[i]);
    }

    // 2. Process all complete 480-sample frames currently in the queue
    while (this.inputQueue.size >= this.FRAME_SIZE) {
      for (let i = 0; i < this.FRAME_SIZE; i++) {
        this.pcmInFrame[i] = this.inputQueue.pop();
      }

      const success = this.processFrame(this.pcmInFrame, this.pcmOutFrame);
      if (success) {
        for (let i = 0; i < this.FRAME_SIZE; i++) {
          this.outputQueue.push(this.pcmOutFrame[i]);
        }
      } else {
        for (let i = 0; i < this.FRAME_SIZE; i++) {
          this.outputQueue.push(this.pcmInFrame[i]);
        }
      }
    }

    // 3. Pop 128 samples from output circular ring buffer to outputChannel
    if (this.outputQueue.size >= quantumSize) {
      for (let i = 0; i < quantumSize; i++) {
        outputChannel[i] = this.outputQueue.pop();
      }
    } else {
      // Initial buffering stage (~10ms buffer fill)
      for (let i = 0; i < quantumSize; i++) {
        outputChannel[i] = inputChannel[i];
      }
    }

    return true;
  }
}

registerProcessor('rnnoise-worklet-processor', RNNoiseWorkletProcessor);
