import { withProductionDeps } from "../src/deps.js";
import { handleSuggestions } from "../src/handlers.js";

export const GET = withProductionDeps(handleSuggestions);
