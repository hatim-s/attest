import { randomBytes } from 'node:crypto';

import { AgentInvocationError } from '../../errors.js';
import { classifiedError } from './websocket-protocol.js';

type WebSocketCloseFrame = {
  code?: number;
  payload: Buffer;
  reason?: string;
};

type WebSocketFrameCallbacks = {
  onClose: (close: WebSocketCloseFrame) => void;
  onFailure: (error: AgentInvocationError) => void;
  onPing: (payload: Buffer) => void;
  onPong: () => void;
  onText: (text: string, bytes: number) => void;
};

/** Encodes one client frame with the masking required by RFC 6455. */
const encodeWebSocketFrame = (
  opcode: number,
  payload: Buffer<ArrayBufferLike> = Buffer.alloc(0),
): Buffer<ArrayBufferLike> => {
  const mask = randomBytes(4);
  const lengthBytes = payload.byteLength < 126 ? 0 : payload.byteLength <= 65_535 ? 2 : 8;
  const header = Buffer.alloc(2 + lengthBytes + mask.byteLength);
  header[0] = 0x80 | opcode;
  if (lengthBytes === 0) {
    header[1] = 0x80 | payload.byteLength;
  } else if (lengthBytes === 2) {
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.byteLength, 2);
  } else {
    header[1] = 0x80 | 127;
    header.writeBigUInt64BE(BigInt(payload.byteLength), 2);
  }
  mask.copy(header, 2 + lengthBytes);
  const masked = Buffer.allocUnsafe(payload.byteLength);
  for (let index = 0; index < payload.byteLength; index += 1) {
    masked[index] = payload[index]! ^ mask[index % 4]!;
  }
  return Buffer.concat([header, masked]);
};

/** Decodes bounded server frames and reassembles fragmented text messages. */
class WebSocketFrameDecoder {
  private buffer = Buffer.alloc(0);
  private failed = false;
  private fragmentedOpcode?: number;
  private fragmentedParts: Buffer[] = [];
  private fragmentedBytes = 0;

  constructor(
    private readonly maximumMessageBytes: number,
    private readonly callbacks: WebSocketFrameCallbacks,
  ) {}

  /** Accepts arbitrary socket chunks and emits each complete protocol frame. */
  accept(chunk: Buffer): void {
    if (this.failed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.parseFrame()) {
      if (this.failed) return;
    }
  }

  private parseFrame(): boolean {
    if (this.buffer.byteLength < 2) return false;
    const first = this.buffer[0]!;
    const second = this.buffer[1]!;
    const final = (first & 0x80) !== 0;
    const opcode = first & 0x0f;
    if ((first & 0x70) !== 0 || (second & 0x80) !== 0) {
      this.protocolFailure('WebSocket server emitted an invalid or masked frame.');
      return false;
    }

    const length = this.readPayloadLength(second);
    if (length === undefined) return false;
    const { headerBytes, payloadBytes } = length;
    if (opcode >= 0x8 && (!final || payloadBytes > 125)) {
      this.protocolFailure('WebSocket server emitted an invalid control frame.');
      return false;
    }
    if (payloadBytes > this.maximumMessageBytes) {
      this.messageTooLarge();
      return false;
    }
    if (this.buffer.byteLength < headerBytes + payloadBytes) return false;
    const payload = this.buffer.subarray(headerBytes, headerBytes + payloadBytes);
    this.buffer = this.buffer.subarray(headerBytes + payloadBytes);
    this.acceptFrame(opcode, final, payload);
    return true;
  }

  private readPayloadLength(
    secondByte: number,
  ): { headerBytes: number; payloadBytes: number } | undefined {
    const marker = secondByte & 0x7f;
    if (marker < 126) return { headerBytes: 2, payloadBytes: marker };
    if (marker === 126) {
      if (this.buffer.byteLength < 4) return undefined;
      return { headerBytes: 4, payloadBytes: this.buffer.readUInt16BE(2) };
    }
    if (this.buffer.byteLength < 10) return undefined;
    const extended = this.buffer.readBigUInt64BE(2);
    if (extended > BigInt(Number.MAX_SAFE_INTEGER)) {
      this.protocolFailure('WebSocket frame length exceeds the supported numeric range.');
      return undefined;
    }
    return { headerBytes: 10, payloadBytes: Number(extended) };
  }

  private acceptFrame(opcode: number, final: boolean, payload: Buffer): void {
    if (opcode === 0x8) {
      this.acceptClose(payload);
      return;
    }
    if (opcode === 0x9) {
      this.callbacks.onPing(payload);
      return;
    }
    if (opcode === 0x0a) {
      this.callbacks.onPong();
      return;
    }
    if (opcode === 0x2 || (opcode === 0x0 && this.fragmentedOpcode === 0x2)) {
      this.fail(
        classifiedError(
          'binary_frame_unsupported',
          'invalid_envelope',
          'Binary WebSocket frames are unsupported.',
        ),
      );
      return;
    }
    if (opcode !== 0x0 && opcode !== 0x1) {
      this.protocolFailure('WebSocket server emitted an unsupported frame opcode.');
      return;
    }
    if (opcode === 0x0 && this.fragmentedOpcode === undefined) {
      this.protocolFailure('WebSocket server emitted an unexpected continuation frame.');
      return;
    }
    if (opcode === 0x1 && this.fragmentedOpcode !== undefined) {
      this.protocolFailure('WebSocket server interleaved fragmented data messages.');
      return;
    }
    if (final) {
      this.finishMessage(opcode, payload);
      return;
    }
    if (opcode !== 0x0) this.fragmentedOpcode = opcode;
    this.fragmentedParts.push(payload);
    this.fragmentedBytes += payload.byteLength;
    if (this.fragmentedBytes > this.maximumMessageBytes) this.messageTooLarge();
  }

  private finishMessage(opcode: number, payload: Buffer): void {
    if (opcode === 0x0 && this.fragmentedBytes + payload.byteLength > this.maximumMessageBytes) {
      this.messageTooLarge();
      return;
    }
    const complete =
      opcode === 0x0
        ? Buffer.concat(
            [...this.fragmentedParts, payload],
            this.fragmentedBytes + payload.byteLength,
          )
        : payload;
    this.fragmentedOpcode = undefined;
    this.fragmentedParts = [];
    this.fragmentedBytes = 0;
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(complete);
      this.callbacks.onText(text, complete.byteLength);
    } catch (cause: unknown) {
      this.fail(
        classifiedError(
          'invalid_json',
          'invalid_envelope',
          'WebSocket text is not valid UTF-8.',
          cause,
        ),
      );
    }
  }

  private acceptClose(payload: Buffer): void {
    let code: number | undefined;
    let reason: string | undefined;
    try {
      if (payload.byteLength === 1) throw new Error('close code is truncated');
      if (payload.byteLength >= 2) {
        code = payload.readUInt16BE(0);
        reason = new TextDecoder('utf-8', { fatal: true }).decode(payload.subarray(2));
      }
    } catch (cause: unknown) {
      this.protocolFailure('WebSocket server emitted an invalid close frame.', cause);
      return;
    }
    this.callbacks.onClose({
      payload,
      ...(code === undefined ? {} : { code }),
      ...(reason === undefined ? {} : { reason: reason.slice(0, 123) }),
    });
  }

  private messageTooLarge(): void {
    this.fail(
      new AgentInvocationError(
        'output_cap_exceeded',
        `WebSocket message exceeds the ${this.maximumMessageBytes}-byte event cap.`,
      ),
    );
  }

  private protocolFailure(message: string, cause?: unknown): void {
    this.fail(classifiedError('connection_failed', 'invalid_envelope', message, cause));
  }

  private fail(error: AgentInvocationError): void {
    if (this.failed) return;
    this.failed = true;
    this.callbacks.onFailure(error);
  }
}

export { WebSocketFrameDecoder, encodeWebSocketFrame, type WebSocketCloseFrame };
