import { withProductionDeps } from "../src/deps.js";
import { handleGetContext, handlePutContext } from "../src/handlers.js";

export const PUT = withProductionDeps(handlePutContext);
export const GET = withProductionDeps(handleGetContext);
