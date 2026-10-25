import { withProductionDeps } from "../src/deps.js";
import { handleConnections } from "../src/handlers.js";

export const GET = withProductionDeps(handleConnections);
export const POST = withProductionDeps(handleConnections);
