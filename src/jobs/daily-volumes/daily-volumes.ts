import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "@/common/logger";
import { redis } from "@/common/redis";
import { config } from "@/config/index";
import { DailyVolume } from "@/entities/daily-volumes/daily-volume";

const QUEUE_NAME = "calculate-daily-volumes";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    backoff: {
      type: "exponential",
      delay: 10000,
    },
    removeOnComplete: true,
    removeOnFail: 10000,
    timeout: 60000,
  },
});

new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      // Get the startTime and endTime of the day we want to calculate
      const startTime = job.data.startTime;
      const ignoreInsertedRows = job.data.ignoreInsertedRows;

      await DailyVolume.calculateDay(startTime, ignoreInsertedRows);

      if (await DailyVolume.tickLock()) {
        logger.info(
          "daily-volumes",
          `All daily volumes are finished processing, updating the collections table`
        );
        await DailyVolume.updateCollections();
      }

      return true;
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );
  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });
}

/**
 * Add a job to the queue with the beginning of the day you want to sync.
 * Beginning of the day is a unix timestamp, starting at 00:00:00
 *
 * @param startTime When startTime is null, we assume we want to calculate the previous day volume.
 * @param ignoreInsertedRows When set to true, we force an update/insert of daily_volume rows, even when they already exist
 */
export const addToQueue = async (
  startTime?: number | null,
  ignoreInsertedRows = true
) => {
  let dayBeginning = new Date();

  if (!startTime) {
    dayBeginning = new Date();
    dayBeginning.setUTCHours(0, 0, 0, 0);
    startTime = dayBeginning.getTime() / 1000 - 24 * 3600;
  }

  await queue.add(randomUUID(), {
    startTime,
    ignoreInsertedRows,
  });
};