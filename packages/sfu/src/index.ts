import * as mediasoup from "mediasoup";
import type {
  Consumer,
  DtlsParameters,
  IceCandidate,
  IceParameters,
  Producer,
  Router,
  RtpCapabilities,
  RtpCodecCapability,
  RtpParameters,
  WebRtcTransport,
  Worker,
} from "mediasoup/types";

/** A local (or announced) IP address the SFU listens on for media. */
export type SfuListenIp = {
  ip: string;
  announcedIp?: string;
};

export type SfuOptions = {
  /** Number of mediasoup Workers to start. Defaults to 1. */
  workerCount?: number;
  /** Lowest UDP/TCP port for media. Required by some hosts; mediasoup picks ports when omitted. */
  rtcMinPort?: number;
  /** Highest UDP/TCP port for media. Required by some hosts; mediasoup picks ports when omitted. */
  rtcMaxPort?: number;
  /** IP addresses the SFU listens on. Defaults to 0.0.0.0. */
  listenIps?: SfuListenIp[];
  /** Media codecs the rooms advertise. Defaults to Opus, VP8, and H264. */
  mediaCodecs?: RtpCodecCapability[];
  /** mediasoup worker log level. */
  logLevel?: "debug" | "warn" | "error" | "none";
};

/** Which way a WebRTC transport is used. Send transports carry Producers; receive transports carry Consumers. */
export type SfuTransportDirection = "send" | "recv";

/** The params a peer needs to connect a mediasoup WebRTC transport to this SFU. */
export type CreatedTransport = {
  transportId: string;
  iceParameters: IceParameters;
  iceCandidates: IceCandidate[];
  dtlsParameters: DtlsParameters;
};

export type CreatedProducer = {
  id: string;
  kind: "audio" | "video";
  appData?: Record<string, unknown>;
};

export type CreatedConsumer = {
  id: string;
  producerId: string;
  kind: "audio" | "video";
  rtpParameters: RtpParameters;
  paused: boolean;
};

export type SfuRoomCreateTransportInput = {
  direction: SfuTransportDirection;
  appData?: Record<string, unknown>;
};

export type SfuRoomProduceInput = {
  transportId: string;
  kind: "audio" | "video";
  rtpParameters: RtpParameters;
  appData?: Record<string, unknown>;
};

export type SfuRoomConsumeInput = {
  transportId: string;
  producerId: string;
  rtpCapabilities: RtpCapabilities;
};

const DEFAULT_LISTEN_IPS: SfuListenIp[] = [{ ip: "0.0.0.0" }];

const DEFAULT_MEDIA_CODECS: RtpCodecCapability[] = [
  { kind: "audio", mimeType: "audio/opus", clockRate: 48000, channels: 2, preferredPayloadType: 111 },
  { kind: "video", mimeType: "video/VP8", clockRate: 90000, preferredPayloadType: 96 },
  {
    kind: "video",
    mimeType: "video/H264",
    clockRate: 90000,
    parameters: { "packetization-mode": 1, "profile-level-id": "42e01f", "level-asymmetry-allowed": 1 },
    preferredPayloadType: 102,
  },
];

/**
 * A single realtime room hosted by the SFU. Owns one mediasoup Router and the
 * WebRTC transports created for the room's participants.
 */
export class SfuRoom {
  readonly roomId: string;
  readonly router: Router;

  private readonly transports = new Map<string, WebRtcTransport>();
  private readonly producers = new Map<string, Producer>();
  private readonly consumers = new Map<string, Consumer>();
  private readonly listenIps: SfuListenIp[];

  constructor(roomId: string, router: Router, listenIps: SfuListenIp[]) {
    this.roomId = roomId;
    this.router = router;
    this.listenIps = listenIps;
  }

  get rtpCapabilities(): RtpCapabilities {
    return this.router.rtpCapabilities;
  }

  get transportCount(): number {
    return this.transports.size;
  }

  /** Creates a server-side WebRTC transport and returns the params a peer needs to connect. */
  async createTransport(input: SfuRoomCreateTransportInput): Promise<CreatedTransport> {
    const transport = await this.router.createWebRtcTransport({
      listenInfos: this.listenInfos(),
      enableUdp: true,
      enableTcp: true,
      preferUdp: true,
      ...(input.direction === "send" ? { initialAvailableOutgoingBitrate: 1_000_000 } : {}),
      appData: { direction: input.direction, ...(input.appData ?? {}) },
    });
    this.transports.set(transport.id, transport);
    return {
      transportId: transport.id,
      iceParameters: transport.iceParameters,
      iceCandidates: transport.iceCandidates,
      dtlsParameters: transport.dtlsParameters,
    };
  }

  /** Connects a previously created transport using the peer's DTLS parameters. */
  async connectTransport(transportId: string, dtlsParameters: DtlsParameters): Promise<void> {
    const transport = this.transport(transportId);
    await transport.connect({ dtlsParameters });
  }

  /** Publishes a media Producer on a send transport. */
  async produce(input: SfuRoomProduceInput): Promise<CreatedProducer> {
    const transport = this.transport(input.transportId);
    const producer = await transport.produce({
      kind: input.kind,
      rtpParameters: input.rtpParameters,
      appData: input.appData ?? {},
    });
    this.producers.set(producer.id, producer);
    producer.on("@close", () => this.producers.delete(producer.id));
    return { id: producer.id, kind: producer.kind, appData: producer.appData };
  }

  /** Subscribes to a remote Producer and forwards it to a receive transport. */
  async consume(input: SfuRoomConsumeInput): Promise<CreatedConsumer> {
    const transport = this.transport(input.transportId);
    if (!this.router.canConsume({ producerId: input.producerId, rtpCapabilities: input.rtpCapabilities })) {
      throw new Error(`Producer ${input.producerId} cannot be consumed with the given RTP capabilities.`);
    }
    const consumer = await transport.consume({
      producerId: input.producerId,
      rtpCapabilities: input.rtpCapabilities,
      paused: true,
    });
    this.consumers.set(consumer.id, consumer);
    consumer.on("@close", () => this.consumers.delete(consumer.id));
    return {
      id: consumer.id,
      producerId: consumer.producerId,
      kind: consumer.kind,
      rtpParameters: consumer.rtpParameters,
      paused: consumer.paused,
    };
  }

  async closeTransport(transportId: string): Promise<void> {
    const transport = this.transports.get(transportId);
    if (!transport) return;
    transport.close();
    this.transports.delete(transportId);
  }

  /** Closes a single Producer. mediasoup closes every Consumer attached to it automatically. */
  closeProducer(producerId: string): void {
    const producer = this.producers.get(producerId);
    if (!producer) return;
    producer.close();
    this.producers.delete(producerId);
  }

  /** Closes a single Consumer. */
  closeConsumer(consumerId: string): void {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    consumer.close();
    this.consumers.delete(consumerId);
  }

  /** Resumes a paused Consumer so forwarded media starts flowing. */
  async resumeConsumer(consumerId: string): Promise<void> {
    const consumer = this.consumers.get(consumerId);
    if (!consumer) return;
    await consumer.resume();
  }

  close(): void {
    this.router.close();
    this.transports.clear();
    this.producers.clear();
    this.consumers.clear();
  }

  private transport(transportId: string): WebRtcTransport {
    const transport = this.transports.get(transportId);
    if (!transport) throw new Error(`Unknown SFU transport ${transportId}.`);
    return transport;
  }

  private listenInfos(): Array<{ protocol: "udp" | "tcp"; ip: string; announcedIp?: string }> {
    return this.listenIps.flatMap(({ ip, announcedIp }) => [
      { protocol: "udp" as const, ip, announcedIp },
      { protocol: "tcp" as const, ip, announcedIp },
    ]);
  }
}

/**
 * The media-routing node. Starts a pool of mediasoup Workers and hosts one
 * Router (via {@link SfuRoom}) per realtime room. Forwards media only; it does
 * not own signaling, authentication, or call lifecycle.
 */
export class SfuNode {
  private readonly options: SfuOptions;
  private readonly workers: Worker[] = [];
  private readonly rooms = new Map<string, SfuRoom>();
  private nextWorker = 0;
  private started = false;

  constructor(options: SfuOptions = {}) {
    this.options = options;
  }

  /** Starts the configured mediasoup Workers. */
  async start(): Promise<void> {
    if (this.started) return;
    const count = this.options.workerCount ?? 1;
    for (let index = 0; index < count; index += 1) {
      const worker = await mediasoup.createWorker({
        rtcMinPort: this.options.rtcMinPort,
        rtcMaxPort: this.options.rtcMaxPort,
        logLevel: this.options.logLevel ?? "warn",
      });
      worker.on("died", (error) => {
        process.emitWarning(`mediasoup Worker died: ${error.message}`, { code: "SFU_WORKER_DIED" });
      });
      this.workers.push(worker);
    }
    this.started = true;
  }

  get workerCount(): number {
    return this.workers.length;
  }

  get roomIds(): string[] {
    return [...this.rooms.keys()];
  }

  room(roomId: string): SfuRoom | undefined {
    return this.rooms.get(roomId);
  }

  /** Returns the existing room or creates one on the least-loaded Worker. */
  async createRoom(roomId: string): Promise<SfuRoom> {
    const existing = this.rooms.get(roomId);
    if (existing) return existing;
    if (!this.started || this.workers.length === 0) throw new Error("SFU is not started. Call start() first.");
    const worker = this.workers[this.nextWorker % this.workers.length];
    this.nextWorker += 1;
    const router = await worker.createRouter({ mediaCodecs: this.options.mediaCodecs ?? DEFAULT_MEDIA_CODECS });
    const listenIps = this.options.listenIps ?? DEFAULT_LISTEN_IPS;
    const room = new SfuRoom(roomId, router, listenIps);
    this.rooms.set(roomId, room);
    return room;
  }

  /** Closes a room and releases its media resources. Returns true if it existed. */
  closeRoom(roomId: string): boolean {
    const room = this.rooms.get(roomId);
    if (!room) return false;
    room.close();
    return this.rooms.delete(roomId);
  }

  /** Closes every room and Worker. */
  async close(): Promise<void> {
    for (const room of this.rooms.values()) room.close();
    this.rooms.clear();
    for (const worker of this.workers) worker.close();
    this.workers.length = 0;
    this.started = false;
  }
}

/** Creates a media-routing node. Call {@link SfuNode.start} before creating rooms. */
export const createSfuNode = (options: SfuOptions = {}): SfuNode => new SfuNode(options);
