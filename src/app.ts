import path from "path";
import fs from "fs";
import express from "express";
import cors from "cors";
import helmet from "helmet";
import morgan from "morgan";
import routes from "./routes";
import { errorHandler } from "./middlewares/error-handler";
import { env } from "./config/env";

export const app = express();

const uploadDir = path.resolve(process.cwd(), env.UPLOAD_DIR);
if (!fs.existsSync(uploadDir)) {
  fs.mkdirSync(uploadDir, { recursive: true });
}

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" },
  }),
);
app.use(cors());
// Capturar rawBody para verificación HMAC en webhooks entrantes
app.use(
  express.json({
    verify: (req: any, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);
// SMS Tools entrega el webhook inbound como x-www-form-urlencoded con nombres
// de campo tipo "data[wid]". Con extended:true se parsean a body.data.wid.
app.use(express.urlencoded({ extended: true }));
app.use(morgan("dev"));

app.use("/uploads", express.static(uploadDir));

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

app.use("/api", routes);
app.use(errorHandler);
