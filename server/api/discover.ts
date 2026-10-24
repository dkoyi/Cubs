import { withProductionDeps } from "../src/deps.js";
import { handleDiscover } from "../src/handlers.js";

export const POST = withProductionDeps(handleDiscover);
