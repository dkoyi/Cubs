import { withProductionDeps } from "../src/deps.js";
import { handlePutContext } from "../src/handlers.js";

export const PUT = withProductionDeps(handlePutContext);
