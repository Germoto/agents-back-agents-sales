/**
 * Socket.IO service para sales-agents.
 *
 * Patrón singleton: el servidor HTTP (server.ts) inicializa el SocketService
 * llamando a SocketService.init(httpServer). A partir de ahí cualquier módulo
 * puede importar { socketService } y emitir eventos a rooms por companyId.
 *
 * Rooms: cada empresa conectada entra a la room `company:<companyId>`.
 * Autenticación: el cliente envía el JWT en el handshake (auth.token).
 *   El middleware del socket lo verifica y extrae el companyId.
 */

import { Server as HttpServer } from "http";
import { Server as SocketServer, Socket } from "socket.io";
import { verifyAccessToken, verifyWebchatToken } from "./jwt";
import { prisma } from "./prisma";

// Eventos emitidos por el servidor al frontend
export const SOCKET_EVENTS = {
  RECEIPT_NEW:          "receipt.new",          // nuevo comprobante creado (vía webhook)
  RECEIPT_UPDATED:      "receipt.updated",      // comprobante actualizado (approve/reject/validated)
  MESSAGE_NEW:          "message.new",          // nuevo mensaje de conversación (inbound u outbound del agente)
  CONVERSATION_UPDATED: "conversation.updated", // estado de conversación cambió (pausa/humano/cierre)
  ORDER_NEW:            "order.new",            // pedido físico registrado por el agente
  BOOKING_NEW:          "booking.new",          // reserva de servicio registrada por el agente
  CRM_UPDATED:          "crm.updated",          // tablero CRM cambió (move/columnas/CRUD)
  CAMPAIGN_PROGRESS:    "campaign.progress",    // avance de una campaña masiva (enviados/fallos/estado)
  WEBCHAT_MESSAGE:      "webchat.message",      // mensaje saliente hacia un visitante del chat web
} as const;

class SocketService {
  private io: SocketServer | null = null;

  init(httpServer: HttpServer): void {
    this.io = new SocketServer(httpServer, {
      cors: {
        origin: "*",
        methods: ["GET", "POST"],
      },
      path: "/socket.io",
    });

    // Middleware de autenticación JWT
    this.io.use(async (socket: Socket, next) => {
      try {
        // Visitante del chat web embebido: entra con su sessionToken (kind
        // "webchat") y SOLO a la room de SU conversación — nunca a company:*.
        const webchatToken = socket.handshake.auth?.webchatToken as string | undefined;
        if (webchatToken) {
          const wc = verifyWebchatToken(webchatToken);
          (socket as any).webchatConversationId = wc.conversationId;
          return next();
        }

        const token = socket.handshake.auth?.token as string | undefined;
        if (!token) return next(new Error("Token requerido"));

        const payload = verifyAccessToken(token);
        const user = await prisma.user.findUnique({
          where: { id: payload.sub },
          select: { id: true, companyId: true, isActive: true },
        });

        if (!user || !user.isActive) return next(new Error("Usuario no autorizado"));

        // Adjuntar companyId al socket para usarlo en la conexión
        (socket as any).companyId = user.companyId;
        next();
      } catch {
        next(new Error("Token inválido"));
      }
    });

    this.io.on("connection", (socket: Socket) => {
      const webchatConversationId = (socket as any).webchatConversationId as string | undefined;
      if (webchatConversationId) {
        void socket.join(`webchat:${webchatConversationId}`);
        socket.on("disconnect", () => undefined);
        return;
      }

      const companyId = (socket as any).companyId as string;
      if (!companyId) {
        socket.disconnect();
        return;
      }

      // Unirse a la room de la empresa
      void socket.join(`company:${companyId}`);
      console.log(`[socket] connected companyId=${companyId} socketId=${socket.id}`);

      socket.on("disconnect", () => {
        console.log(`[socket] disconnected socketId=${socket.id}`);
      });
    });

    console.log("[socket] Socket.IO server initialized");
  }

  /** Emite un evento a todos los clientes conectados de una empresa */
  emitToCompany(companyId: string, event: string, data: unknown): void {
    if (!this.io) return;
    this.io.to(`company:${companyId}`).emit(event, data);
  }

  /** Emite un evento al visitante del chat web de UNA conversación */
  emitToWebchat(conversationId: string, event: string, data: unknown): void {
    if (!this.io) return;
    this.io.to(`webchat:${conversationId}`).emit(event, data);
  }
}

// Singleton exportado
export const socketService = new SocketService();
