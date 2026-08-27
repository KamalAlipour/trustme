import React from 'react';
import { labels } from '../labels';

export function Flash({ message, type }: Readonly<{ message?: string | undefined; type?: string | undefined }>) {
  if (!message) return null;
  const isError = type === 'error';
  return <p role="alert" className={`rounded border p-3 text-sm ${isError ? 'border-red-300 bg-red-50 text-red-800' : 'border-emerald-300 bg-emerald-50 text-emerald-800'}`}>{isError ? labels.error : labels.success}: {message}</p>;
}
