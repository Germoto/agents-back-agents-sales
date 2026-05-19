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
app.use(express.json());
app.use(morgan("dev"));

app.use("/uploads", express.static(uploadDir));

app.get("/health", (_req, res) => {
  res.json({ success: true, status: "ok" });
});

app.use("/api", routes);
app.use(errorHandler);
