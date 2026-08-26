/**
 * Chunked Local File Transfer Engine over Socket.io
 * Enables direct high-speed LAN file sharing without server disk writes or memory bloat.
 */
class FileTransferEngine {
  constructor(socket) {
    this.socket = socket;
    this.CHUNK_SIZE = 64 * 1024; // 64 KB per chunk
    this.incomingTransfers = new Map(); // fileId -> { name, size, type, senderName, chunks: [], receivedBytes, totalChunks }
  }

  /**
   * Send a file to everyone in the room via chunked ArrayBuffers
   */
  async sendFile(file, onProgress, onComplete, onError) {
    if (!file || file.size === 0) return;

    const fileId = 'file_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6);
    const totalChunks = Math.ceil(file.size / this.CHUNK_SIZE);

    // 1. Emit metadata to start transfer
    this.socket.emit('file-start', {
      fileId,
      fileName: file.name,
      fileSize: file.size,
      fileType: file.type || 'application/octet-stream',
      totalChunks
    });

    let offset = 0;
    let chunkIndex = 0;

    const readAndSendChunk = () => {
      if (offset >= file.size) {
        // Transfer finished
        this.socket.emit('file-end', { fileId });
        if (onComplete) onComplete({ fileId, fileName: file.name, fileSize: file.size });
        return;
      }

      const slice = file.slice(offset, offset + this.CHUNK_SIZE);
      const reader = new FileReader();

      reader.onload = (e) => {
        const buffer = e.target.result;
        this.socket.emit('file-chunk', {
          fileId,
          chunkIndex,
          totalChunks,
          data: buffer
        });

        offset += buffer.byteLength;
        chunkIndex++;

        const percent = Math.min(100, Math.round((offset / file.size) * 100));
        if (onProgress) onProgress(percent, offset, file.size);

        // Schedule next chunk to maintain non-blocking UI thread
        setTimeout(readAndSendChunk, 2);
      };

      reader.onerror = (err) => {
        console.error('File read error:', err);
        if (onError) onError(err);
      };

      reader.readAsArrayBuffer(slice);
    };

    // Kickoff sending
    readAndSendChunk();
  }

  /**
   * Register Socket Listeners for receiving incoming file transfers
   */
  setupReceiveListeners(onFileStart, onFileProgress, onFileComplete) {
    this.socket.on('file-start', (meta) => {
      this.incomingTransfers.set(meta.fileId, {
        fileId: meta.fileId,
        fileName: meta.fileName,
        fileSize: meta.fileSize,
        fileType: meta.fileType,
        senderId: meta.senderId,
        senderName: meta.senderName,
        timestamp: meta.timestamp,
        totalChunks: meta.totalChunks,
        chunks: new Array(meta.totalChunks),
        receivedChunksCount: 0,
        receivedBytes: 0
      });

      if (onFileStart) onFileStart(meta);
    });

    this.socket.on('file-chunk', (chunkObj) => {
      const transfer = this.incomingTransfers.get(chunkObj.fileId);
      if (!transfer) return;

      // Store chunk (data arrives as ArrayBuffer or Uint8Array)
      transfer.chunks[chunkObj.chunkIndex] = chunkObj.data;
      transfer.receivedChunksCount++;
      transfer.receivedBytes += chunkObj.data.byteLength;

      const percent = Math.min(100, Math.round((transfer.receivedChunksCount / transfer.totalChunks) * 100));
      if (onFileProgress) onFileProgress(chunkObj.fileId, percent, transfer.receivedBytes, transfer.fileSize);
    });

    this.socket.on('file-end', ({ fileId }) => {
      const transfer = this.incomingTransfers.get(fileId);
      if (!transfer) return;

      // Assemble all chunks into single Blob
      const blob = new Blob(transfer.chunks, { type: transfer.fileType });
      const objectUrl = URL.createObjectURL(blob);

      const completedFile = {
        fileId: transfer.fileId,
        fileName: transfer.fileName,
        fileSize: transfer.fileSize,
        fileType: transfer.fileType,
        senderName: transfer.senderName,
        timestamp: transfer.timestamp,
        url: objectUrl,
        blob
      };

      if (onFileComplete) onFileComplete(completedFile);
      this.incomingTransfers.delete(fileId);
    });
  }
}

window.FileTransferEngine = FileTransferEngine;
