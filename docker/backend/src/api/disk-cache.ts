import * as fs from 'fs';
const fsPromises = fs.promises;
import * as process from 'process';
import * as cluster from 'cluster';
import memPool from './mempool';
import blocks from './blocks';
import logger from '../logger';
import config from '../config';

class DiskCache {
  private static FILE_NAME = config.MEMPOOL.CACHE_DIR + 'cache.json';
  private static FILE_NAMES = config.MEMPOOL.CACHE_DIR + 'cache{number}.json';
  private static CHUNK_SIZE = 10000;
  constructor() {
    if (!cluster.isMaster) {
      return;
    }
    process.on('SIGINT', () => {
      this.saveCacheToDiskSync();
      process.exit(2);
    });
    process.on('SIGTERM', () => {
      this.saveCacheToDiskSync();
      process.exit(2);
    });
  }

  async $saveCacheToDisk(): Promise<void> {
    if (!cluster.isMaster) {
      return;
    }
    try {
      logger.debug('Writing mempool and blocks data to disk cache (async)...');
      const mempoolChunk_1 = Object.fromEntries(Object.entries(memPool.getMempool()).slice(0, DiskCache.CHUNK_SIZE));
      await fsPromises.writeFile(DiskCache.FILE_NAME, JSON.stringify({
        blocks: blocks.getBlocks(),
        mempool: mempoolChunk_1
      }), {flag: 'w'});
      for (let i = 1; i < 10; i++) {
        const mempoolChunk = Object.fromEntries(
          Object.entries(memPool.getMempool()).slice(
            DiskCache.CHUNK_SIZE * i, i === 9 ? undefined : DiskCache.CHUNK_SIZE * i + DiskCache.CHUNK_SIZE
          )
        );
        await fsPromises.writeFile(DiskCache.FILE_NAMES.replace('{number}', i.toString()), JSON.stringify({
          mempool: mempoolChunk
        }), {flag: 'w'});
      }
      logger.debug('Mempool and blocks data saved to disk cache');
    } catch (e) {
      logger.warn('Error writing to cache file: ' + e.message || e);
    }
  }

  saveCacheToDiskSync(): void {
    try {
      logger.debug('Writing mempool and blocks data to disk cache...');
      const mempoolChunk_1 = Object.fromEntries(Object.entries(memPool.getMempool()).slice(0, DiskCache.CHUNK_SIZE));
      fs.writeFileSync(DiskCache.FILE_NAME, JSON.stringify({
        blocks: blocks.getBlocks(),
        mempool: mempoolChunk_1
      }), {flag: 'w'});
      for (let i = 1; i < 10; i++) {
        const mempoolChunk = Object.fromEntries(
          Object.entries(memPool.getMempool()).slice(
            DiskCache.CHUNK_SIZE * i, i === 9 ? undefined : DiskCache.CHUNK_SIZE * i + DiskCache.CHUNK_SIZE
          )
        );
        fs.writeFileSync(DiskCache.FILE_NAMES.replace('{number}', i.toString()), JSON.stringify({
          mempool: mempoolChunk
        }), {flag: 'w'});
      }

      logger.debug('Mempool and blocks data saved to disk cache');
    } catch (e) {
      logger.warn('Error writing to cache file: ' + e.message || e);
    }
  }

  loadMempoolCache() {
    if (!fs.existsSync(DiskCache.FILE_NAME)) {
      return;
    }
    let data: any = {};
    const cacheData = fs.readFileSync(DiskCache.FILE_NAME, 'utf8');
    if (cacheData) {
      logger.info('Restoring mempool and blocks data from disk cache');
      data = JSON.parse(cacheData);
    }

    for (let i = 1; i < 10; i++) {
      const fileName = DiskCache.FILE_NAMES.replace('{number}', i.toString());
      if (fs.existsSync(fileName)) {
        const cacheData2 = JSON.parse(fs.readFileSync(fileName, 'utf8'));
        Object.assign(data.mempool, cacheData2.mempool);
      }
    }

    memPool.setMempool(data.mempool);
    blocks.setBlocks(data.blocks);
  }
}

export default new DiskCache();
