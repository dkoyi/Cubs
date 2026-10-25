import { withProductionDeps } from "../../../src/deps.js";
import { handleDelivered } from "../../../src/handlers.js";

export const POST = withProductionDeps(handleDelivered);
