import { servePayments } from "../_shared/payments/deps.ts";
import { createHandler } from "./handler.ts";

servePayments(createHandler);
