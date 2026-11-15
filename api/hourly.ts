import { getRequestListener } from '@hono/node-server';
import { handleSchedule } from '@vercel/schedules';
import { scheduledPoll } from '../src/vercel/app.js';
import { safeError } from '../src/types.js';
export default getRequestListener(
  handleSchedule(async (metadata) => {
    try {
      await scheduledPoll(metadata.scheduledAt.getTime(), metadata.executionId);
    } catch (e) {
      console.error('hourly:', safeError(e).code);
      throw new Error(safeError(e).code);
    }
  }),
);
