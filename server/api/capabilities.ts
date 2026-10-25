import { withProductionDeps } from "../src/deps.js";
import { handleCapabilities } from "../src/handlers.js";

export const GET = withProductionDeps(handleCapabilities);
