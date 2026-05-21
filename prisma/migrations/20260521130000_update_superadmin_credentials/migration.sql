-- Update SUPERADMIN phone and password
UPDATE "User"
SET
  "phone" = '+51963337953',
  "passwordHash" = '$2b$10$oe/B/zGb3QsU7U0IZaAlYOemfECrXXAeZ15yIhSxuIrii8l4FD24S'
WHERE "role" = 'SUPERADMIN';
