import { serveReminders } from "../_shared/reminders/deps.ts";
import { createHandler } from "./handler.ts";

serveReminders(createHandler);
