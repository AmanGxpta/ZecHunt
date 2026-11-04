/** An expected, user-facing failure. Routes map it to an HTTP status. */
export class DomainError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message?: string,
  ) {
    super(message ?? code);
    this.name = "DomainError";
  }
}
