import { describe, it, expect, vi, beforeEach } from "vitest";

// env se parsea al importar el módulo; por eso los imports son dinámicos con
// vi.resetModules() para probar con y sin CREDENTIALS_ENC_KEY.
async function loadWithKey(key: string) {
  vi.resetModules();
  process.env.CREDENTIALS_ENC_KEY = key;
  process.env.DATABASE_URL = process.env.DATABASE_URL || "postgresql://test:test@localhost:5432/test";
  process.env.JWT_SECRET = process.env.JWT_SECRET || "test-secret";
  return import("../credentials-crypto");
}

describe("credentials-crypto", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it("roundtrip cifrado/descifrado con clave", async () => {
    const { encryptCredential, decryptCredential } = await loadWithKey("clave-de-prueba");
    const token = "EAAG-token-super-secreto-1234";
    const stored = encryptCredential(token);
    expect(stored).toMatch(/^enc:v1:/);
    expect(stored).not.toContain(token);
    expect(decryptCredential(stored)).toBe(token);
  });

  it("sin clave: passthrough en texto plano", async () => {
    const { encryptCredential, decryptCredential } = await loadWithKey("");
    expect(encryptCredential("plano")).toBe("plano");
    expect(decryptCredential("plano")).toBe("plano");
  });

  it("valores planos se descifran tal cual aunque haya clave (compatibilidad)", async () => {
    const { decryptCredential } = await loadWithKey("clave-de-prueba");
    expect(decryptCredential("token-guardado-plano")).toBe("token-guardado-plano");
    expect(decryptCredential(null)).toBe("");
    expect(decryptCredential(undefined)).toBe("");
  });

  it("payload cifrado corrupto devuelve cadena vacía (no lanza)", async () => {
    const { decryptCredential } = await loadWithKey("clave-de-prueba");
    expect(decryptCredential("enc:v1:no-es-base64-valido!!!")).toBe("");
  });
});
