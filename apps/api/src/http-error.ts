export class HttpError extends Error {
  public readonly status: number;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}
