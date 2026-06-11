import { Request, Response } from "express";
import { createProduct, deleteProduct, getProduct, listProducts, reorderProducts, toggleProductActive, toggleProductShowInCatalog, updateProduct } from "./products.service";

export async function listProductsController(req: Request, res: Response) {
  const products = await listProducts(req.user!.companyId);
  return res.json(products);
}

export async function getProductController(req: Request, res: Response) {
  const product = await getProduct(req.user!.companyId, String(req.params.id));
  return res.json(product);
}

export async function createProductController(req: Request, res: Response) {
  const product = await createProduct(req.user!.companyId, req.body);
  return res.status(201).json(product);
}

export async function updateProductController(req: Request, res: Response) {
  const product = await updateProduct(req.user!.companyId, String(req.params.id), req.body);
  return res.json(product);
}

export async function deleteProductController(req: Request, res: Response) {
  const result = await deleteProduct(req.user!.companyId, String(req.params.id));
  return res.json(result);
}

export async function toggleProductActiveController(req: Request, res: Response) {
  const result = await toggleProductActive(req.user!.companyId, String(req.params.id));
  return res.json(result);
}

export async function toggleProductCatalogController(req: Request, res: Response) {
  const result = await toggleProductShowInCatalog(req.user!.companyId, String(req.params.id));
  return res.json(result);
}

export async function reorderProductsController(req: Request, res: Response) {
  const ids = Array.isArray(req.body?.ids) ? (req.body.ids as unknown[]).map(String) : [];
  const result = await reorderProducts(req.user!.companyId, ids);
  return res.json(result);
}
