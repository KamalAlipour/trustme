export class DomainError extends Error {
  public readonly status: number;

  public constructor(message: string, status = 400) {
    super(message);
    this.name = 'DomainError';
    this.status = status;
  }
}
