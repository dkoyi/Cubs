import { withProductionDeps } from "../src/deps.js";
import { handleMatches } from "../src/handlers.js";

export const GET = withProductionDeps(handleMatches);
