-- AlterTable
ALTER TABLE "DigitalDelivery" ADD COLUMN     "onSaleRemoveTagIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "onPresentationRemoveTagIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "onPaymentCrmId" UUID,
ADD COLUMN     "onPaymentCrmColumnId" UUID,
ADD COLUMN     "onPaymentTagIds" UUID[] DEFAULT ARRAY[]::UUID[],
ADD COLUMN     "onPaymentRemoveTagIds" UUID[] DEFAULT ARRAY[]::UUID[];

-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "contextRemoveTagIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
