import type { Response } from "express";
import { ServiceError } from "./common";

/** Answers a ServiceError as `{ error }` with its status. Returns false for any other error. */
export function sendServiceError(res: Response, err: unknown): boolean {
  if (!(err instanceof ServiceError)) return false;
  res.status(err.status).json({ error: err.message });
  return true;
}
