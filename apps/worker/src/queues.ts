import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';

export const INGEST_QUEUE = 'trustme-chain-ingest';
export const DISPATCH_QUEUE = 'trustme-withdrawal-dispatch';
export const CONFIRMATION_QUEUE = 'trustme-withdrawal-confirmation';
export const SWEEP_QUEUE = 'trustme-deposit-sweep';
export const SMS_QUEUE = 'trustme-sms-otp';

export type WorkerQueues = {
  connection: Redis;
  ingest: Queue;
  dispatch: Queue;
  confirmation: Queue;
  sweep: Queue;
  sms: Queue;
};

export function createQueues(redisUrl: string): WorkerQueues {
  const connection = new Redis(redisUrl, { maxRetriesPerRequest: null });
  return {
    connection,
    ingest: new Queue(INGEST_QUEUE, { connection }),
    dispatch: new Queue(DISPATCH_QUEUE, { connection }),
    confirmation: new Queue(CONFIRMATION_QUEUE, { connection }),
    sweep: new Queue(SWEEP_QUEUE, { connection }),
    sms: new Queue(SMS_QUEUE, { connection }),
  };
}

export async function closeQueues(queues: WorkerQueues, workers: Worker[]): Promise<void> {
  await Promise.all(workers.map((worker) => worker.close()));
  await Promise.all([queues.ingest.close(), queues.dispatch.close(), queues.confirmation.close(), queues.sweep.close(), queues.sms.close(), queues.connection.quit()]);
}
