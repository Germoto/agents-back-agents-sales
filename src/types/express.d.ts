import { UserRole } from "@prisma/client";

declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        companyId: string;
        name: string;
        phone: string;
        role: UserRole;
        isActive: boolean;
      };
    }
  }
}

export {};
