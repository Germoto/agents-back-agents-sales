import { Router } from "express";
import { asyncHandler } from "../../lib/async-handler";
import { requireAuth } from "../../middlewares/auth.middleware";
import { validate } from "../../middlewares/validate";
import { approveReceiptController, deleteReceiptController, listReceiptsController, rejectReceiptController } from "./receipts.controller";
import { receiptIdParamsSchema, rejectReceiptSchema } from "./receipts.schemas";

const router = Router();

router.use(requireAuth);
router.get("/", asyncHandler(listReceiptsController));
router.post("/:id/approve", validate({ params: receiptIdParamsSchema }), asyncHandler(approveReceiptController));
router.post("/:id/reject", validate({ params: receiptIdParamsSchema, body: rejectReceiptSchema }), asyncHandler(rejectReceiptController));
router.delete("/:id", validate({ params: receiptIdParamsSchema }), asyncHandler(deleteReceiptController));

export default router;
