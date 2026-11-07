// Input rules the API server enforces too. Keep each value in step with its server copy;
// the forms check them first only to show a friendly message before the request.

/**
 * Minimum password length for accounts created or changed through the API.
 * Server: MIN_PASSWORD_LENGTH in artifacts/api-server/src/lib/passwordPolicy.ts.
 */
export const MIN_PASSWORD_LENGTH = 8;

/** The password-length message for forms, or null when `password` is long enough. */
export function passwordLengthError(password: string): string | null {
  return password.length < MIN_PASSWORD_LENGTH ? `Password must be at least ${MIN_PASSWORD_LENGTH} characters.` : null;
}

/**
 * BIR TIN: 9-digit TIN plus a 3- or 5-digit branch code, e.g. 123-456-789-000 or 123-456-789-00000.
 * Server: TIN_PATTERN in artifacts/api-server/src/routes/clients.ts (POST / PATCH /clients answer 400).
 */
export const TIN_PATTERN = /^\d{3}-\d{3}-\d{3}-(\d{3}|\d{5})$/;
