/* eslint-disable @typescript-eslint/no-explicit-any */

import _ from "lodash";
import { Job, Queue, QueueScheduler, Worker } from "bullmq";
import { randomUUID } from "crypto";

import { logger } from "@/common/logger";
import { redis, redlock } from "@/common/redis";
import { config } from "@/config/index";

import { idb } from "@/common/db";
import { fromBuffer } from "@/common/utils";

const QUEUE_NAME = "resync-orders-source-queue";

export const queue = new Queue(QUEUE_NAME, {
  connection: redis.duplicate(),
  defaultJobOptions: {
    attempts: 10,
    removeOnComplete: 10000,
    removeOnFail: 10000,
  },
});
new QueueScheduler(QUEUE_NAME, { connection: redis.duplicate() });

// BACKGROUND WORKER ONLY
if (config.doBackgroundWork) {
  const worker = new Worker(
    QUEUE_NAME,
    async (job: Job) => {
      const { continuation } = job.data;
      const limit = 2000;
      let continuationFilter = "";

      if (continuation != "") {
        continuationFilter = `WHERE id > '${continuation}'`;
      }

      const query = `SELECT id, source_id, source_id_int
                     FROM orders
                     ${continuationFilter}
                     ORDER BY slug ASC
                     LIMIT ${limit}`;

      const orders = await idb.manyOrNone(query);

      if (orders) {
        for (const order of orders) {
          const sourceId = fromBuffer(order.source_id);
          let sourceIdInt;

          switch (sourceId) {
            case "0x5b3256965e7c3cf26e11fcaf296dfc8807c01073": // OpenSea
              sourceIdInt = 1;
              break;

            case "0xfdfda3d504b1431ea0fd70084b1bfa39fa99dcc4": // Forgotten Market
              sourceIdInt = 2;
              break;

            case "0x5924a28caaf1cc016617874a2f0c3710d881f3c1": // LooksRare
              sourceIdInt = 3;
              break;
          }

          try {
            const query = `UPDATE orders
                           SET source_id_int = $/sourceIdInt/
                           WHERE id = $/id/`;

            const values = {
              id: order.id,
              sourceIdInt,
            };

            await idb.none(query, values);
          } catch (error) {
            logger.error(QUEUE_NAME, `${error}`);
          }
        }

        if (_.size(orders) == limit) {
          const lastOrder = _.last(orders);
          logger.info(
            QUEUE_NAME,
            `Updated ${limit} orders, lastOrder=${JSON.stringify(lastOrder)}`
          );

          await addToQueue(lastOrder.id);
        }
      }
    },
    { connection: redis.duplicate(), concurrency: 1 }
  );

  worker.on("error", (error) => {
    logger.error(QUEUE_NAME, `Worker errored: ${error}`);
  });

  redlock
    .acquire(["order-resync"], 60 * 24 * 30 * 1000)
    .then(() => addToQueue())
    .catch(() => {
      // Skip on any errors
    });
}

export const addToQueue = async (continuation = "") => {
  await queue.add(randomUUID(), { continuation });
};
