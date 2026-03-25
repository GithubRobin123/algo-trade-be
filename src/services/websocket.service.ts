import { IncomingMessage, Server as HttpServer } from 'http';
import { WebSocket, WebSocketServer } from 'ws';

interface SocketMessage {
  event: string;
  data: unknown;
  ts: string;
}

class WebSocketService {
  private wss: WebSocketServer | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;

  init(server: HttpServer): void {
    if (this.wss) {
      return;
    }

    this.wss = new WebSocketServer({ noServer: true });

    server.on('upgrade', (request, socket, head) => {
      if (!request.url?.startsWith('/ws')) {
        socket.destroy();
        return;
      }

      this.wss?.handleUpgrade(request, socket, head, (client) => {
        this.wss?.emit('connection', client, request);
      });
    });

    this.wss.on('connection', (client: WebSocket, _request: IncomingMessage) => {
      this.send(client, {
        event: 'connected',
        data: { message: 'WebSocket connection established' },
        ts: new Date().toISOString(),
      });
    });

    this.heartbeatTimer = setInterval(() => {
      this.broadcast('heartbeat', { uptimeMs: process.uptime() * 1000 });
    }, 15000);
  }

  broadcast(event: string, data: unknown): void {
    if (!this.wss) {
      return;
    }

    const payload: SocketMessage = {
      event,
      data,
      ts: new Date().toISOString(),
    };

    const serialized = JSON.stringify(payload);

    this.wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(serialized);
      }
    });
  }

  close(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }

    this.wss?.close();
    this.wss = null;
  }

  private send(client: WebSocket, payload: SocketMessage): void {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(payload));
    }
  }
}

export const websocketService = new WebSocketService();
