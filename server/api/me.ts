import { withProductionDeps } from "../src/deps.js";
import { handleLeave } from "../src/handlers.js";

export const DELETE = withProductionDeps(handleLeave);
