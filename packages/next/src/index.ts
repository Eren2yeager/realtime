import { createServer, type RequestListener, type Server as HttpServer } from "node:http";
import { createRealtimeServer, type RealtimeServer, type RealtimeServerOptions } from "@realtime/server";

/** A Next.js request handler (typically `app.getRequestHandler()`). */
export type NextApplication = RequestListener;

export type NextRealtime = {
  realtime: RealtimeServer;
  httpServer: HttpServer;
  start: (port?: number) => Promise<void>;
  close: () => Promise<void>;
};

/** Creates a custom Next.js HTTP server with realtime transport attached. */
export const createNextRealtime = (app: NextApplication, options: RealtimeServerOptions): NextRealtime => {
  const realtime = createRealtimeServer({ ...options, port: undefined });
  const httpServer = createServer(app);
  realtime.attach(httpServer);
  return {
    realtime,
    httpServer,
    start: async (port = options.port ?? 3000) => {
      await new Promise<void>((resolve, reject) => {
        const onError = (error: Error) => { httpServer.off("listening", onListening); reject(error); };
        const onListening = () => { httpServer.off("error", onError); resolve(); };
        httpServer.once("error", onError);
        httpServer.once("listening", onListening);
        httpServer.listen(port);
      });
    },
    close: async () => {
      httpServer.closeAllConnections?.();
      await realtime.close();
      if (!httpServer.listening) return;
      await new Promise<void>((resolve, reject) => httpServer.close((error) => error ? reject(error) : resolve()));
    }
  };
};

/** Attaches realtime transport to an existing custom Next.js HTTP server. */
export const attachRealtimeToNext = (realtime: RealtimeServer, httpServer: HttpServer): RealtimeServer => {
  realtime.attach(httpServer);
  return realtime;
};

export type { RealtimeServerOptions, RealtimeServer } from "@realtime/server";
