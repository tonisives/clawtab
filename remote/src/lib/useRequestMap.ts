// Simple callback registry for correlating WS request/response by message id
const pending = new Map<string, (data: any) => void>();

export function registerRequest<T>(id: string): Promise<T> {
  return new Promise((resolve) => {
    pending.set(id, resolve);
  });
}

export function resolveRequest(id: string, data: unknown): boolean {
  const cb = pending.get(id);
  if (!cb) return false;
  pending.delete(id);
  cb(data);
  return true;
}
