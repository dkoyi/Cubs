// Vercel routes /api/suggestions/{id}/answer here; the handler reads the id from the path.
import { withProductionDeps } from "../../../src/deps.js";
import { handleAnswer } from "../../../src/handlers.js";

export const POST = withProductionDeps(handleAnswer);
