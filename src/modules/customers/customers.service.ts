import { prisma } from "../../lib/prisma";
import { AppError } from "../../lib/app-error";

export async function listCustomers(companyId: string) {
  return prisma.customer.findMany({
    where: { companyId },
    include: {
      selectedProduct: {
        select: {
          id: true,
          slug: true,
          name: true,
        },
      },
    },
    orderBy: { lastInteractionAt: "desc" },
  });
}

/** Ficha completa de un contacto para el panel de Conversaciones. */
export async function getCustomer(companyId: string, customerId: string) {
  const customer = await prisma.customer.findFirst({
    where: { id: customerId, companyId },
    include: {
      selectedProduct: { select: { id: true, slug: true, name: true } },
      deals: { orderBy: { createdAt: "desc" }, select: { id: true, description: true, amount: true, createdAt: true } },
      tagLinks: { select: { tag: { select: { id: true, name: true, color: true } } } },
    },
  });
  if (!customer) throw new AppError("Cliente no encontrado", 404);
  const { tagLinks, deals, ...rest } = customer;
  return {
    ...rest,
    tags: tagLinks.map((l) => l.tag),
    deals: deals.map((d) => ({ ...d, amount: Number(d.amount) })),
  };
}

export interface UpdateCustomerInput {
  name?: string | null;
  email?: string | null;
  sexo?: string | null;
  fechaNacimiento?: string | null;
  idioma?: string | null;
  origenDeLead?: string | null;
  selectedProductId?: string | null;
}

export async function updateCustomer(companyId: string, customerId: string, data: UpdateCustomerInput) {
  const existing = await prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Cliente no encontrado", 404);

  // Validar producto de interés (si viene)
  if (data.selectedProductId) {
    const product = await prisma.product.findFirst({
      where: { id: data.selectedProductId, companyId },
      select: { id: true },
    });
    if (!product) throw new AppError("Producto no encontrado", 404);
  }

  await prisma.customer.update({
    where: { id: customerId },
    data: {
      name: data.name ?? undefined,
      email: data.email ?? undefined,
      sexo: data.sexo ?? undefined,
      fechaNacimiento:
        data.fechaNacimiento === undefined
          ? undefined
          : data.fechaNacimiento
            ? new Date(data.fechaNacimiento)
            : null,
      idioma: data.idioma ?? undefined,
      origenDeLead: data.origenDeLead ?? undefined,
      selectedProductId: data.selectedProductId === undefined ? undefined : data.selectedProductId || null,
    },
  });
  return getCustomer(companyId, customerId);
}

// --- Notas internas por contacto ---

export async function listNotes(companyId: string, customerId: string) {
  return prisma.contactNote.findMany({
    where: { companyId, customerId },
    orderBy: { createdAt: "desc" },
  });
}

export async function createNote(
  companyId: string,
  customerId: string,
  data: { text?: string | null; mediaUrl?: string | null; mediaType?: string | null; conversationId?: string | null },
) {
  const customer = await prisma.customer.findFirst({ where: { id: customerId, companyId }, select: { id: true } });
  if (!customer) throw new AppError("Cliente no encontrado", 404);
  if (!data.text?.trim() && !data.mediaUrl) {
    throw new AppError("La nota necesita texto o un archivo", 400);
  }
  return prisma.contactNote.create({
    data: {
      companyId,
      customerId,
      conversationId: data.conversationId ?? null,
      text: data.text?.trim() || null,
      mediaUrl: data.mediaUrl ?? null,
      mediaType: data.mediaType ?? null,
    },
  });
}

export async function deleteNote(companyId: string, noteId: string) {
  const existing = await prisma.contactNote.findFirst({ where: { id: noteId, companyId }, select: { id: true } });
  if (!existing) throw new AppError("Nota no encontrada", 404);
  await prisma.contactNote.delete({ where: { id: noteId } });
}
