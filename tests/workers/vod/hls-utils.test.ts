import fsPromises from 'fs/promises';
import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';
import { cleanupOrphanedTmpFiles, fetchKickPlaylist, getSegmentFileName } from '../../../src/workers/vod/hls-utils.js';

describe('cleanupOrphanedTmpFiles', () => {
  it('should not throw when directory is empty', async () => {
    const mockReaddir = fsPromises.readdir;
    const files: string[] = [];

    (fsPromises as any).readdir = async () => files;

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await assert.doesNotReject(cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any));

    (fsPromises as any).readdir = mockReaddir;
  });

  it('should remove .tmp files', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    const removedFiles: string[] = [];

    (fsPromises as any).readdir = async () => ['segment1.ts', 'segment2.tmp', 'playlist.m3u8', 'data.tmp'];
    (fsPromises as any).unlink = async (path: string) => {
      if (path.endsWith('.tmp')) {
        removedFiles.push(path);
      }
    };

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(removedFiles.length, 2);
    assert.ok(removedFiles.some((f) => f.includes('segment2.tmp')));
    assert.ok(removedFiles.some((f) => f.includes('data.tmp')));

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should skip non-.tmp files', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    let unlinkCalled = false;

    (fsPromises as any).readdir = async () => ['segment1.ts', 'playlist.m3u8'];
    (fsPromises as any).unlink = async () => {
      unlinkCalled = true;
    };

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(unlinkCalled, false);

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should handle unlink errors gracefully', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    let warnCalled = false;

    (fsPromises as any).readdir = async () => ['segment.tmp'];
    (fsPromises as any).unlink = async () => {
      throw new Error('Permission denied');
    };

    const mockLog = {
      debug: () => {},
      warn: (ctx: any) => {
        warnCalled = true;
        assert.ok(ctx.error);
      },
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(warnCalled, true);

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should handle directory read errors gracefully', async () => {
    const mockReaddir = fsPromises.readdir;
    let warnCalled = false;

    (fsPromises as any).readdir = async () => {
      throw new Error('ENOENT');
    };

    const mockLog = {
      debug: () => {},
      warn: (ctx: any) => {
        warnCalled = true;
        assert.ok(ctx.error);
      },
    };

    await cleanupOrphanedTmpFiles('/nonexistent-directory', mockLog as any);

    assert.strictEqual(warnCalled, true);

    (fsPromises as any).readdir = mockReaddir;
  });

  it('should only clean .tmp files, not .tmp.bak or other extensions', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    const removedFiles: string[] = [];

    (fsPromises as any).readdir = async () => ['file.tmp', 'file.tmp.bak', 'file.backup.tmp.old'];
    (fsPromises as any).unlink = async (path: string) => {
      if (path.endsWith('.tmp')) {
        removedFiles.push(path);
      }
    };

    const mockLog = {
      debug: () => {},
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.strictEqual(removedFiles.length, 1);
    assert.ok(removedFiles[0]?.endsWith('.tmp'));

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });

  it('should log debug message for each cleaned file', async () => {
    const mockReaddir = fsPromises.readdir;
    const mockUnlink = fsPromises.unlink;
    const debugMessages: string[] = [];

    (fsPromises as any).readdir = async () => ['segment.tmp'];
    (fsPromises as any).unlink = async () => {};

    const mockLog = {
      debug: (_ctx: unknown, msg: string) => {
        debugMessages.push(msg);
      },
      warn: () => {},
    };

    await cleanupOrphanedTmpFiles('/tmp/test-vod', mockLog as any);

    assert.ok(debugMessages.some((m) => m.includes('Cleaned up orphaned')));

    (fsPromises as any).readdir = mockReaddir;
    (fsPromises as any).unlink = mockUnlink;
  });
});

describe('fetchKickPlaylist', () => {
  it('handles Kick live playback URLs that return a master playlist', async () => {
    const calls: string[] = [];
    const session = {
      fetchText: async (url: string) => {
        calls.push(url);
        if (url === 'https://playback.example.com/channel.m3u8?token=abc') {
          return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720
https://playlist.example.com/live/variant.m3u8`;
        }
        if (url === 'https://playlist.example.com/live/variant.m3u8') {
          return `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
segment-1.ts`;
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    const result = await fetchKickPlaylist(
      'vod-1',
      'https://playback.example.com/channel.m3u8?token=abc',
      { error: () => {} } as any,
      session as any
    );

    assert.deepStrictEqual(calls, [
      'https://playback.example.com/channel.m3u8?token=abc',
      'https://playlist.example.com/live/variant.m3u8',
    ]);
    assert.strictEqual(result.baseURL, 'https://playlist.example.com/live');
    assert.ok(result.variantM3u8String.includes('segment-1.ts'));
  });

  it('handles relative Kick master playlist variants', async () => {
    const calls: string[] = [];
    const session = {
      fetchText: async (url: string) => {
        calls.push(url);
        if (url === 'https://stream.kick.com/path/master.m3u8') {
          return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720
720p/playlist.m3u8`;
        }
        if (url === 'https://stream.kick.com/path/720p/playlist.m3u8') {
          return `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
segment-1.ts`;
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    const result = await fetchKickPlaylist(
      'vod-1',
      'https://stream.kick.com/path/master.m3u8',
      { error: () => {} } as any,
      session as any
    );

    assert.deepStrictEqual(calls, [
      'https://stream.kick.com/path/master.m3u8',
      'https://stream.kick.com/path/720p/playlist.m3u8',
    ]);
    assert.strictEqual(result.baseURL, 'https://stream.kick.com/path/720p');
  });

  it('handles Kick master playlists with strict-parser-invalid VIDEO attributes', async () => {
    const calls: string[] = [];
    const session = {
      fetchText: async (url: string) => {
        calls.push(url);
        if (url === 'https://stream.kick.com/path/master.m3u8') {
          return `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720,VIDEO="chunked"
720p/playlist.m3u8`;
        }
        if (url === 'https://stream.kick.com/path/720p/playlist.m3u8') {
          return `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
segment-1.ts`;
        }
        throw new Error(`Unexpected URL ${url}`);
      },
    };

    const result = await fetchKickPlaylist(
      'vod-1',
      'https://stream.kick.com/path/master.m3u8',
      { error: () => {} } as any,
      session as any
    );

    assert.deepStrictEqual(calls, [
      'https://stream.kick.com/path/master.m3u8',
      'https://stream.kick.com/path/720p/playlist.m3u8',
    ]);
    assert.strictEqual(result.baseURL, 'https://stream.kick.com/path/720p');
    assert.ok(result.variantM3u8String.includes('segment-1.ts'));
  });
});

describe('getSegmentFileName', () => {
  it('uses a stable hashed name for absolute segment URLs', () => {
    const result = getSegmentFileName('https://cdn.example.com/live/segment-1.ts?token=abc');
    assert.match(result, /^[a-f0-9]{24}\.ts$/);
    assert.strictEqual(result, getSegmentFileName('https://cdn.example.com/live/segment-1.ts?token=abc'));
  });

  it('preserves relative segment names', () => {
    assert.strictEqual(getSegmentFileName('segment-2.ts'), 'segment-2.ts');
  });

  it('avoids collisions for distinct URLs with the same basename', () => {
    const first = getSegmentFileName('https://cdn.example.com/rendition-a/segment.ts?token=abc');
    const second = getSegmentFileName('https://cdn.example.com/rendition-b/segment.ts?token=abc');

    assert.notStrictEqual(first, second);
    assert.match(first, /^[a-f0-9]{24}\.ts$/);
    assert.match(second, /^[a-f0-9]{24}\.ts$/);
  });

  it('avoids collisions for query-distinguished relative segment names', () => {
    const first = getSegmentFileName('segment.ts?token=abc');
    const second = getSegmentFileName('segment.ts?token=def');

    assert.notStrictEqual(first, second);
    assert.match(first, /^[a-f0-9]{24}\.ts$/);
    assert.match(second, /^[a-f0-9]{24}\.ts$/);
  });

  it('truncates very long file names and hashes them', () => {
    const longName = 'a'.repeat(300);
    const result = getSegmentFileName(`https://example.com/${longName}`);
    assert.ok(result.length <= 200, 'filename should be truncated');
    assert.strictEqual(result.length, 24); // just the hash
  });

  it('truncates very long extensions', () => {
    const longExt = 'b'.repeat(100);
    const result = getSegmentFileName(`https://example.com/${'a'.repeat(300)}.${longExt}`);
    assert.ok(result.length <= 200, 'filename should be truncated');
    assert.strictEqual(result.length, 24 + 10); // hash + 10 char extension (including the dot)
  });
});
