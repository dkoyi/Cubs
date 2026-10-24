import { withProductionDeps } from "../src/deps.js";
import { handleJoin } from "../src/handlers.js";

export const POST = withProductionDeps(handleJoin);
