-- Animación 3D del landing público, elegible desde el superadmin
ALTER TABLE "PlatformConfig" ADD COLUMN "landingScene" TEXT NOT NULL DEFAULT 'constelacion';
