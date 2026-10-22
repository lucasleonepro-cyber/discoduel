import { getStore } from "@netlify/blobs";
import { handlePlay } from "../lib/core.mjs";

// POST /api/play — counts (anonymously) the artist and albums chosen for a tournament
export default async (req) => handlePlay(req, { store: getStore({ name: "discoduel", consistency: "strong" }) });

export const config = { path: "/api/play" };
