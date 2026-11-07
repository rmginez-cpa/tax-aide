/** Minimum password length for accounts created or changed through the API. */
export const MIN_PASSWORD_LENGTH = 8;

/** Returns an error message when `password` does not meet the policy, otherwise null. */
export function passwordPolicyError(password: unknown): string | null {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;
  }
  return null;
}
