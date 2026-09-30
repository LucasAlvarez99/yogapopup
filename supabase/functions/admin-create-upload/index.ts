import { serve } from "../_shared/deps.ts";
import { createHandler } from "./handler.ts";

serve(createHandler);
