import { getStore } from "@netlify/blobs";
import { handleDaily } from "../lib/core.mjs";

// GET /api/daily — today's challenge (picked from what players chose) + community ranking so far
export default async (req) => handleDaily(req, { store: getStore({ name: "discoduel", consistency: "strong" }) });

export const config = { path: "/api/daily" };
