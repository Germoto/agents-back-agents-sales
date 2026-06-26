import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { approveReceiptController, associateReceiptController, deleteReceiptController, getReceiptProofController, ignoreReceiptController, listReceiptsController, rejectReceiptController } from "./receipts.controller";
import { approveReceiptSchema, associateReceiptSchema, receiptIdParamsSchema, rejectReceiptSchema } from "./receipts.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listReceiptsController));
router.get("/:id/proof", validate({ params: receiptIdParamsSchema }), asyncHandler(getReceiptProofController));
router.post("/:id/approve", validate({ params: receiptIdParamsSchema, body: approveReceiptSchema }), asyncHandler(approveReceiptController));
router.post("/:id/associate", validate({ params: receiptIdParamsSchema, body: associateReceiptSchema }), asyncHandler(associateReceiptController));
router.post("/:id/ignore", validate({ params: receiptIdParamsSchema }), asyncHandler(ignoreReceiptController));
router.post("/:id/reject", validate({ params: receiptIdParamsSchema, body: rejectReceiptSchema }), asyncHandler(rejectReceiptController));
router.delete("/:id", validate({ params: receiptIdParamsSchema }), asyncHandler(deleteReceiptController));

export default router;
