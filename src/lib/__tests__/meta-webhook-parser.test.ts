import { describe, it, expect } from "vitest";
import { parseMetaWebhook } from "../meta-webhook-parser";

const PHONE_NUMBER_ID = "111222333444555";

function envelope(value: Record<string, unknown>) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA_ID",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { display_phone_number: "51987654321", phone_number_id: PHONE_NUMBER_ID },
              ...value,
            },
          },
        ],
      },
    ],
  };
}

describe("parseMetaWebhook", () => {
  it("parsea un texto entrante al shape InboundMessage", () => {
    const parsed = parseMetaWebhook(
      envelope({
        contacts: [{ profile: { name: "Juan" }, wa_id: "51999888777" }],
        messages: [
          {
            from: "51999888777",
            id: "wamid.HBgL123",
            timestamp: "1719850000",
            type: "text",
            text: { body: "Hola, info del curso" },
          },
        ],
      }),
    );
    expect(parsed.statuses).toHaveLength(0);
    expect(parsed.messages).toHaveLength(1);
    const { inbound, phoneNumberId, mediaId } = parsed.messages[0];
    expect(phoneNumberId).toBe(PHONE_NUMBER_ID);
    expect(mediaId).toBeNull();
    expect(inbound).toMatchObject({
      messageId: "wamid.HBgL123",
      fromPhone: "51999888777",
      businessPhone: "51987654321",
      account: PHONE_NUMBER_ID,
      text: "Hola, info del curso",
      type: "text",
      mediaUrl: null,
      fromMe: false,
    });
  });

  it("parsea una imagen con caption (comprobante) y expone el media id", () => {
    const parsed = parseMetaWebhook(
      envelope({
        messages: [
          {
            from: "51999888777",
            id: "wamid.IMG1",
            type: "image",
            image: { id: "MEDIA_ID_123", mime_type: "image/jpeg", caption: "mi comprobante" },
          },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(1);
    const { inbound, mediaId } = parsed.messages[0];
    expect(mediaId).toBe("MEDIA_ID_123");
    expect(inbound.type).toBe("image");
    expect(inbound.text).toBe("mi comprobante");
    expect(inbound.mediaUrl).toBeNull();
  });

  it("parsea statuses delivered y failed (131047) por wamid", () => {
    const parsed = parseMetaWebhook(
      envelope({
        statuses: [
          { id: "wamid.OK1", status: "delivered", recipient_id: "51999888777" },
          {
            id: "wamid.FAIL1",
            status: "failed",
            recipient_id: "51999888777",
            errors: [{ code: 131047, title: "Re-engagement message" }],
          },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(0);
    expect(parsed.statuses).toHaveLength(2);
    expect(parsed.statuses[0]).toMatchObject({ wamid: "wamid.OK1", status: "delivered", errorCode: null });
    expect(parsed.statuses[1]).toMatchObject({
      wamid: "wamid.FAIL1",
      status: "failed",
      errorCode: 131047,
      errorMessage: "Re-engagement message",
      phoneNumberId: PHONE_NUMBER_ID,
    });
  });

  it("respuesta interactiva (botón) llega como texto", () => {
    const parsed = parseMetaWebhook(
      envelope({
        messages: [
          {
            from: "51999888777",
            id: "wamid.BTN",
            type: "interactive",
            interactive: { type: "button_reply", button_reply: { id: "b1", title: "Sí, quiero" } },
          },
        ],
      }),
    );
    expect(parsed.messages[0].inbound.text).toBe("Sí, quiero");
    expect(parsed.messages[0].inbound.type).toBe("text");
  });

  it("descarta reacciones y tipos sin contenido", () => {
    const parsed = parseMetaWebhook(
      envelope({
        messages: [
          { from: "51999888777", id: "wamid.R", type: "reaction", reaction: { message_id: "x", emoji: "👍" } },
          { from: "51999888777", id: "wamid.U", type: "unsupported" },
        ],
      }),
    );
    expect(parsed.messages).toHaveLength(0);
  });

  it("payload malformado no revienta: devuelve listas vacías", () => {
    expect(parseMetaWebhook(null)).toEqual({ messages: [], statuses: [] });
    expect(parseMetaWebhook("basura")).toEqual({ messages: [], statuses: [] });
    expect(parseMetaWebhook({ entry: [{ changes: [{ field: "otro" }] }] })).toEqual({
      messages: [],
      statuses: [],
    });
  });
});
