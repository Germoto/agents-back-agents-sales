-- Restore SUPERADMIN user linked to the same company as the existing ADMIN
-- Phone: +51963337953 / Password: Pa$$w0rd.01
INSERT INTO "User" (
  "id",
  "companyId",
  "name",
  "phone",
  "passwordHash",
  "role",
  "isActive",
  "createdAt",
  "updatedAt"
)
SELECT
  gen_random_uuid(),
  u."companyId",
  'Control Maestro',
  '+51963337953',
  '$2b$10$oe/B/zGb3QsU7U0IZaAlYOemfECrXXAeZ15yIhSxuIrii8l4FD24S',
  'SUPERADMIN',
  true,
  NOW(),
  NOW()
FROM "User" u
WHERE u."phone" = '+51928018265'
ON CONFLICT ("phone") DO UPDATE SET
  "role"         = 'SUPERADMIN',
  "passwordHash" = '$2b$10$oe/B/zGb3QsU7U0IZaAlYOemfECrXXAeZ15yIhSxuIrii8l4FD24S',
  "isActive"     = true,
  "updatedAt"    = NOW();
