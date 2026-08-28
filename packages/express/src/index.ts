import { createServer, type RequestListener, type Server as HttpServer } from "node:http";
import { createRealtimeServer, type RealtimeServer, type RealtimeServerOptions } from "@realtimesdk/server";

/** Express applications implement Node's request-listener contract. */
export type ExpressApplication = RequestListener;

/** A realtime server attached to an Express application and its HTTP server. */
export type ExpressRealtime = {
  realtime: RealtimeServer;
  httpServer: HttpServer;
  start: (port?: number) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Creates an Express HTTP server and attaches realtime transport to it.
 * The returned `start` method owns listening; authentication and room policy
 * remain the same options accepted by `@realtimesdk/server`.
 */
export const createExpressRealtime = (app: ExpressApplication, options: RealtimeServerOptions): ExpressRealtime => {
  const realtime = createRealtimeServer({ ...options, port: undefined });
  const httpServer = createServer(app);
  realtime.attach(httpServer);
  return {
    realtime,
    httpServer,
    start: async (port = options.port ?? 3001) => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { httpServer.off("listening", onListening); reject(error); };
        const onListening = () => { httpServer.off("error", onError); resolve(); };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port);
      });
    },
    close: async () => {
      // A keep-alive connection from an HTTP health check can otherwise keep
      // Node's server close callback pending after Socket.IO has shut down.
      httpServer.closeAllConnections?.();
      await realtime.close();
      if (!httpServer.listening) return;
      await new Promise<void>((resolve, reject) => {
        httpServer.close((error) => error ? reject(error) : resolve());
      });
    }
  };
};

/** Attaches an existing realtime server to an Express app's HTTP server. */
export const attachRealtimeToExpress = (realtime: RealtimeServer, app: ExpressApplication): HttpServer => {
  const httpServer = createServer(app);
  realtime.attach(httpServer);
  return httpServer;
};

export type { RealtimeServerOptions, RealtimeServer } from "@realtimesdk/server";
