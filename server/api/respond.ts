import { withProductionDeps } from "../src/deps.js";
import { handleRespond } from "../src/handlers.js";

export const POST = withProductionDeps(handleRespond);
