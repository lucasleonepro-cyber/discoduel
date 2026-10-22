import { getStore } from "@netlify/blobs";
import { handleDailyResult } from "../lib/core.mjs";

// POST /api/daily-result — adds one player's ranking of today's album to the community ranking
export default async (req) => handleDailyResult(req, { store: getStore({ name: "discoduel", consistency: "strong" }) });

export const config = { path: "/api/daily-result" };
