import { strict as assert } from 'node:assert';
import { describe, it, beforeEach, afterEach, mock } from 'node:test';
import HLS from 'hls-parser';
import { Hls } from '../../../src/constants.js';
import { PLATFORMS } from '../../../src/types/platforms.js';
import { DownloadAbortedError } from '../../../src/utils/domain-errors.js';
import type { ImpitSession } from '../../../src/utils/impit-wrapper.js';

const VALID_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function setupBaseEnv(): void {
  Object.keys(process.env).forEach((key) => delete process.env[key]);
  process.env.REDIS_URL = 'redis://localhost';
  process.env.META_DATABASE_URL = 'postgresql://meta';
  process.env.PGBOUNCER_URL = 'postgresql://bouncer';
  process.env.ENCRYPTION_MASTER_KEY = VALID_KEY;
  process.env.NODE_ENV = 'test';
  process.env.TMP_PATH = '/tmp/test-tmp';
  process.env.VOD_PATH = '/tmp/test-vods';
  process.env.TWITCH_CLIENT_ID = 'test-twitch-client-id';
  process.env.TWITCH_CLIENT_SECRET = 'test-twitch-client-secret';
  process.env.YOUTUBE_CLIENT_ID = 'test-youtube-client-id';
  process.env.YOUTUBE_CLIENT_SECRET = 'test-youtube-client-secret';
}

setupBaseEnv();

// ============================================================================
// Hoisted mocks — must be registered before the module under test is imported
// ============================================================================
const mockFsMkdir: any = mock.fn(async (_path: string, _opts: any) => {});
const mockFsWriteFile: any = mock.fn(async (_path: string, _data: string) => {});
const mockFsReadFile: any = mock.fn(async (_path: string) => mockPlaylistVariantM3u8);
const mockFsReaddir: any = mock.fn(async (_path: string) => ['seg001.ts', 'seg002.ts', 'seg003.ts', 'vod.mp4']);
const mockFsStat: any = mock.fn(async (_path: string) => ({ size: 1024 }));

const mockFetchTwitchPlaylist: any = mock.fn(async () => mockPlaylistResult);
const mockFetchKickPlaylist: any = mock.fn(async () => mockPlaylistResult);
const mockDownloadSegmentsParallel: any = mock.fn(async () => {});
const mockResolveDownloadStrategy: any = mock.fn(() => ({ type: 'fetch', abort: () => {} }));
const mockConvertHlsToMp4: any = mock.fn(async () => {});
const mockDetectFmp4FromPlaylist: any = mock.fn(() => false);
const mockGetMetadata: any = mock.fn(async () => ({ duration: 30 }));
const mockSleep: any = mock.fn(async () => {});
const mockGetRetryDelay: any = mock.fn(() => 0);
const mockCreateSession: any = mock.fn(() => ({
  streamToFile: mock.fn(async () => {}),
  fetchText: mock.fn(async () => ''),
  closed: false,
  close: () => {
    sessionCloseCalled = true;
  },
}));
const mockGetVodDirPath: any = mock.fn(() => '/tmp/test-vods/test-tenant/vod-123');
const mockGetVodFilePath: any = mock.fn(() => '/tmp/test-vods/test-tenant/vod-123/vod-123.mp4');
const mockUpdateChapterDuringDownload: any = mock.fn(async () => {});
const mockGetVod: any = mock.fn(async () => ({ source: 'https://example.com/archive/master.m3u8' }));
const mockGetKickStreamStatus: any = mock.fn(async () => null);
const mockGetKickStreamStatusResult: any = mock.fn(async () => ({ status: 'offline' }));
const mockUpdateVodDurationDuringDownload: any = mock.fn(async () => {});

function mockGetSegmentFileName(uri: string): string {
  const withoutQuery = uri.split(/[?#]/, 1)[0] ?? uri;
  const parts = withoutQuery.split('/');
  return parts.at(-1) ?? uri;
}

let sessionCloseCalled = false;
let logCalls: Array<{ level: string; args: unknown[] }> = [];

const mockPlaylistResult = {
  variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXTINF:10.0,\nseg002.ts\n#EXTINF:10.0,\nseg003.ts\n#EXT-X-ENDLIST`,
  baseURL: 'https://example.com/segments',
};

const mockPlaylistVariantM3u8 = mockPlaylistResult.variantM3u8String;

mock.module('fs/promises', {
  namedExports: {
    mkdir: mockFsMkdir,
    writeFile: mockFsWriteFile,
    readFile: mockFsReadFile,
    readdir: mockFsReaddir,
    stat: mockFsStat,
    access: mock.fn(async () => {}),
  },
});

mock.module('../../../src/utils/path.js', {
  namedExports: {
    getVodDirPath: () => {
      mockGetVodDirPath();
      return '/tmp/test-vods/test-tenant/vod-123';
    },
    getVodFilePath: () => {
      mockGetVodFilePath();
      return '/tmp/test-vods/test-tenant/vod-123/vod-123.mp4';
    },
    getTmpDirPath: () => '/tmp/test-tmp/test-tenant/vod-123',
    getTmpFilePath: () => '/tmp/test-tmp/test-tenant/vod-123/vod-123.mp4',
  },
});

mock.module('../../../src/utils/impit-wrapper.js', {
  namedExports: {
    createSession: mockCreateSession,
  },
});

mock.module('../../../src/utils/delay.js', {
  namedExports: {
    sleep: mockSleep,
    getRetryDelay: mockGetRetryDelay,
  },
});

mock.module('../../../src/workers/vod/hls-utils.js', {
  namedExports: {
    downloadSegmentsParallel: mockDownloadSegmentsParallel,
    fetchTwitchPlaylist: mockFetchTwitchPlaylist,
    fetchKickPlaylist: mockFetchKickPlaylist,
    getSegmentFileName: mockGetSegmentFileName,
    resolveDownloadStrategy: mockResolveDownloadStrategy,
  },
});

mock.module('../../../src/workers/utils/ffmpeg.js', {
  namedExports: {
    convertHlsToMp4: mockConvertHlsToMp4,
    detectFmp4FromPlaylist: mockDetectFmp4FromPlaylist,
    getMetadata: mockGetMetadata,
  },
});

mock.module('../../../src/services/kick/index.js', {
  namedExports: {
    getKickStreamStatus: mockGetKickStreamStatus,
    getKickStreamStatusResult: mockGetKickStreamStatusResult,
    getVod: mockGetVod,
    updateChapterDuringDownload: mockUpdateChapterDuringDownload,
  },
});

mock.module('../../../src/workers/vod/duration-updater.js', {
  namedExports: {
    updateVodDurationDuringDownload: mockUpdateVodDurationDuringDownload,
  },
});

mock.module('../../../src/utils/auto-tenant-logger.js', {
  namedExports: {
    createAutoLogger: () => ({
      info: (...args: unknown[]) => logCalls.push({ level: 'info', args }),
      debug: (...args: unknown[]) => logCalls.push({ level: 'debug', args }),
      warn: (...args: unknown[]) => logCalls.push({ level: 'warn', args }),
      error: (...args: unknown[]) => logCalls.push({ level: 'error', args }),
    }),
  },
});

// ============================================================================
// System Under Test — Dynamically imported AFTER mock.module registrations
// ============================================================================
const { downloadHlsStream, filterNewSegments, fetchPlaylist } =
  await import('../../../src/workers/vod/hls-orchestrator.js');

// ============================================================================
// filterNewSegments — pure function unit tests
// ============================================================================

function makeSeg(uri: string, duration = 10, mediaSequenceNumber = 0) {
  return {
    uri,
    duration,
    mimeType: '',
    data: null,
    byterange: null,
    mediaSequenceNumber,
    discontinuitySequenceNumber: 0,
    programDateTime: null,
    t: null,
    attributes: {},
  } as unknown as HLS.types.Segment;
}

describe('filterNewSegments', () => {
  it('should return all segments as new when downloadedSegments is empty', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts'), makeSeg('seg003.ts')];

    const result = filterNewSegments(segments, new Set<string>(), null, 0);

    assert.strictEqual(result.newSegments.length, 3);
    assert.strictEqual(result.isStreamEnd, false);
    assert.strictEqual(result.newLastSegmentUri, 'seg003.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should return only new segments not in downloadedSegments', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts'), makeSeg('seg003.ts')];

    const downloaded = new Set(['seg001.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg001.ts', 0);

    assert.strictEqual(result.newSegments.length, 2);
    assert.strictEqual(result.newSegments[0]!.uri, 'seg002.ts');
    assert.strictEqual(result.newSegments[1]!.uri, 'seg003.ts');
  });

  it('should return empty newSegments when all segments already downloaded', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', 0);

    assert.strictEqual(result.newSegments.length, 0);
  });

  it('should increment noChangeCount when last segment URI matches previous', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', 3);

    assert.strictEqual(result.newNoChangeCount, 4);
    assert.strictEqual(result.newLastSegmentUri, 'seg002.ts');
  });

  it('should reset noChangeCount when last segment URI changes', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts'), makeSeg('seg003.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', 4);

    assert.strictEqual(result.newNoChangeCount, 0);
    assert.strictEqual(result.newLastSegmentUri, 'seg003.ts');
  });

  it('should set isStreamEnd when noChangeCount reaches NO_CHANGE_THRESHOLD', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', Hls.NO_CHANGE_THRESHOLD - 1);

    assert.strictEqual(result.isStreamEnd, true);
  });

  it('should set isStreamEnd when noChangeCount exceeds NO_CHANGE_THRESHOLD', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', Hls.NO_CHANGE_THRESHOLD + 10);

    assert.strictEqual(result.isStreamEnd, true);
  });

  it('should not set isStreamEnd when noChangeCount is below threshold', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const downloaded = new Set(['seg001.ts', 'seg002.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg002.ts', Hls.NO_CHANGE_THRESHOLD - 2);

    assert.strictEqual(result.isStreamEnd, false);
  });

  it('should handle empty segments array', () => {
    const segments: HLS.types.Segment[] = [];

    const result = filterNewSegments(segments, new Set<string>(), null, 0);

    assert.strictEqual(result.newSegments.length, 0);
    assert.strictEqual(result.isStreamEnd, false);
    assert.strictEqual(result.newLastSegmentUri, '');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should handle empty last segment URI (empty string) without triggering no-change', () => {
    const segments = [makeSeg('seg001.ts')];

    const result = filterNewSegments(segments, new Set<string>(), '', 0);

    assert.strictEqual(result.newSegments.length, 1);
    assert.strictEqual(result.newLastSegmentUri, 'seg001.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should not increment noChangeCount when last segment URI is empty string', () => {
    const segments = [makeSeg('seg001.ts')];

    const result = filterNewSegments(segments, new Set<string>(), '', 0);

    assert.strictEqual(result.newLastSegmentUri, 'seg001.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should track noChangeCount from zero when first non-empty URI is seen', () => {
    const segments = [makeSeg('seg001.ts'), makeSeg('seg002.ts')];

    const result = filterNewSegments(segments, new Set<string>(), null, 0);

    assert.strictEqual(result.newLastSegmentUri, 'seg002.ts');
    assert.strictEqual(result.newNoChangeCount, 0);
  });

  it('should return correct new segments with mixed downloaded/undownloaded', () => {
    const segments = [
      makeSeg('seg001.ts'),
      makeSeg('seg002.ts'),
      makeSeg('seg003.ts'),
      makeSeg('seg004.ts'),
      makeSeg('seg005.ts'),
    ];

    const downloaded = new Set(['seg001.ts', 'seg003.ts', 'seg005.ts']);
    const result = filterNewSegments(segments, downloaded, 'seg004.ts', 0);

    assert.strictEqual(result.newSegments.length, 2);
    assert.strictEqual(result.newSegments[0]!.uri, 'seg002.ts');
    assert.strictEqual(result.newSegments[1]!.uri, 'seg004.ts');
  });

  it('should compare absolute segment URLs by local file name', () => {
    const segments = [
      makeSeg('https://cdn.example.com/live/seg001.ts?token=abc'),
      makeSeg('https://cdn.example.com/live/seg002.ts?token=abc'),
    ];

    const downloaded = new Set(['seg001.ts']);
    const result = filterNewSegments(segments, downloaded, 'https://cdn.example.com/live/seg001.ts?token=abc', 0);

    assert.strictEqual(result.newSegments.length, 1);
    assert.strictEqual(result.newSegments[0]!.uri, 'https://cdn.example.com/live/seg002.ts?token=abc');
  });

  it('should compare token-rotated segments by media sequence when available', () => {
    const segments = [makeSeg('https://cdn.example.com/live/seg001.ts?token=fresh', 10, 42)];

    const downloaded = new Set(['media-sequence:42']);
    const result = filterNewSegments(segments, downloaded, 'https://cdn.example.com/live/seg001.ts?token=old', 0);

    assert.strictEqual(result.newSegments.length, 0);
  });

  it('should use segments.at(-1) for last URI detection', () => {
    const segments = [makeSeg('a.ts'), makeSeg('b.ts'), makeSeg('c.ts')];

    const downloaded = new Set(['a.ts', 'b.ts', 'c.ts']);
    const result = filterNewSegments(segments, downloaded, 'c.ts', 0);

    assert.strictEqual(result.newLastSegmentUri, 'c.ts');
    assert.strictEqual(result.newNoChangeCount, 1);
  });
});

// ============================================================================
// fetchPlaylist — dispatch test
// ============================================================================

describe('fetchPlaylist', () => {
  beforeEach(() => {
    mockFetchTwitchPlaylist.mock.resetCalls();
    mockFetchKickPlaylist.mock.resetCalls();
    mockFetchTwitchPlaylist.mock.mockImplementation(async () => ({
      variantM3u8String: '#EXTM3U\n#EXT-X-ENDLIST',
      baseURL: 'https://twitch.example.com',
    }));
    mockFetchKickPlaylist.mock.mockImplementation(async () => ({
      variantM3u8String: '#EXTM3U\n#EXT-X-ENDLIST',
      baseURL: 'https://kick.example.com',
    }));
  });

  it('should dispatch to fetchTwitchPlaylist for Twitch platform', async () => {
    const result = await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 1 }
    );

    assert.strictEqual(mockFetchTwitchPlaylist.mock.callCount(), 1);
    assert.strictEqual(result.variantM3u8String, '#EXTM3U\n#EXT-X-ENDLIST');
  });

  it('should dispatch to fetchKickPlaylist for Kick platform', async () => {
    const result = await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.KICK,
        sourceUrl: 'https://kick.example.com/master.m3u8',
      } as any,
      { attempts: 1 }
    );

    assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), 1);
    assert.strictEqual(result.variantM3u8String, '#EXTM3U\n#EXT-X-ENDLIST');
  });

  it('should pass vodId to fetchTwitchPlaylist', async () => {
    await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'unique-vod-id',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 1 }
    );

    const call = mockFetchTwitchPlaylist.mock.calls[0];
    assert.strictEqual(call.arguments[0], 'unique-vod-id');
  });

  it('should pass sourceUrl and impitSession to fetchKickPlaylist', async () => {
    const mockSession = {
      fetchText: mock.fn(async () => ''),
      closed: false,
      close: () => {},
    } as unknown as ImpitSession;
    await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.KICK,
        sourceUrl: 'https://kick.example.com/playlist.m3u8',
        impitSession: mockSession,
      } as any,
      { attempts: 1 }
    );

    const call = mockFetchKickPlaylist.mock.calls[0];
    assert.strictEqual(call.arguments[1], 'https://kick.example.com/playlist.m3u8');
    assert.strictEqual(call.arguments[3], mockSession);
  });

  it('should pass retryOptions to both platform fetchers', async () => {
    await fetchPlaylist(
      {
        ctx: { tenantId: 't1', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 5, baseDelayMs: 3000 }
    );

    const call = mockFetchTwitchPlaylist.mock.calls[0];
    assert.deepStrictEqual(call.arguments[3], { attempts: 5, baseDelayMs: 3000 });
  });

  it('should pass tenantId to fetchTwitchPlaylist', async () => {
    await fetchPlaylist(
      {
        ctx: { tenantId: 'tenant-abc', config: {} as any, db: {} as any },
        vodId: 'vod-1',
        platform: PLATFORMS.TWITCH,
      } as any,
      { attempts: 1 }
    );

    const call = mockFetchTwitchPlaylist.mock.calls[0];
    assert.strictEqual(call.arguments[2], 'tenant-abc');
  });
});

// ============================================================================
// downloadHlsStream — integration tests
// ============================================================================

function buildContext(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: 'test-tenant',
    config: {
      id: 'test-tenant',
      displayName: 'Test Tenant',
      createdAt: new Date(),
      database: { name: 'test' },
      settings: {
        domainName: 'test.com',
        timezone: 'UTC',
        saveHLS: false,
        saveMP4: true,
        vodDownload: true,
        chatDownload: true,
        cdn: { enabled: false, baseUrl: '' },
      },
      status: 'active' as const,
      ...overrides,
    },
    db: {} as any,
    ...overrides,
  };
}

function buildOptions(overrides: Record<string, unknown> = {}) {
  return {
    ctx: buildContext(),
    dbId: 42,
    vodId: 'vod-123',
    platform: PLATFORMS.TWITCH,
    platformUserId: 'user-1',
    isLive: false,
    ...overrides,
  };
}

describe('downloadHlsStream', () => {
  beforeEach(() => {
    sessionCloseCalled = false;
    logCalls = [];

    // Explicitly restore default positive mocked states to prevent inter-suite leakage
    mockFetchTwitchPlaylist.mock.mockImplementation(async () => mockPlaylistResult);
    mockFetchKickPlaylist.mock.mockImplementation(async () => mockPlaylistResult);
    mockDownloadSegmentsParallel.mock.mockImplementation(async () => {});
    mockFsReadFile.mock.mockImplementation(async () => mockPlaylistVariantM3u8);
    mockGetKickStreamStatus.mock.mockImplementation(async () => null);
    mockGetKickStreamStatusResult.mock.mockImplementation(async () => ({ status: 'offline' }));
    mockGetVod.mock.mockImplementation(async () => ({ source: 'https://example.com/archive/master.m3u8' }));
    mockGetRetryDelay.mock.mockImplementation(() => 0);
    mockGetMetadata.mock.mockImplementation(async () => ({ duration: 30 }));
  });

  afterEach(() => {
    mockFsMkdir.mock.resetCalls();
    mockFsWriteFile.mock.resetCalls();
    mockFsReadFile.mock.resetCalls();
    mockFsReaddir.mock.resetCalls();
    mockFsStat.mock.resetCalls();
    mockFetchTwitchPlaylist.mock.resetCalls();
    mockFetchKickPlaylist.mock.resetCalls();
    mockDownloadSegmentsParallel.mock.resetCalls();
    mockResolveDownloadStrategy.mock.resetCalls();
    mockConvertHlsToMp4.mock.resetCalls();
    mockDetectFmp4FromPlaylist.mock.resetCalls();
    mockGetMetadata.mock.resetCalls();
    mockSleep.mock.resetCalls();
    mockGetRetryDelay.mock.resetCalls();
    mockCreateSession.mock.resetCalls();
    mockGetVodDirPath.mock.resetCalls();
    mockGetVodFilePath.mock.resetCalls();
    mockGetKickStreamStatus.mock.resetCalls();
    mockGetKickStreamStatusResult.mock.resetCalls();
    mockGetVod.mock.resetCalls();
    mockUpdateChapterDuringDownload.mock.resetCalls();
    mockUpdateVodDurationDuringDownload.mock.resetCalls();
  });

  describe('archived VOD path', () => {
    it('should download archived VOD and return correct result', async () => {
      const result = await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.TWITCH,
          platformUserId: 'user-1',
          platformUsername: 'testuser',
          isLive: false,
        })
      );

      assert.ok(result.success);
      assert.strictEqual(result.segmentCount, 4); // Readdir mock returns 4 files
      assert.strictEqual(mockFsMkdir.mock.callCount(), 1);
      assert.strictEqual(mockFsWriteFile.mock.callCount(), 1);
      assert.strictEqual(mockDownloadSegmentsParallel.mock.callCount(), 1);
      assert.strictEqual(mockConvertHlsToMp4.mock.callCount(), 1);
    });

    it('should call convertHlsToMp4 with fmp4=false when detectFmp4FromPlaylist returns false', async () => {
      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false }));

      assert.strictEqual(mockDetectFmp4FromPlaylist.mock.callCount(), 1);
      assert.strictEqual(mockConvertHlsToMp4.mock.callCount(), 1);
    });

    it('should fail conversion when output duration is much shorter than playlist duration', async () => {
      mockGetMetadata.mock.mockImplementation(async () => ({ duration: 6 }));

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false })),
        /Converted MP4 duration 6s is shorter than playlist duration 30s/
      );
    });

    it('should fail conversion when output metadata has no valid video duration', async () => {
      mockGetMetadata.mock.mockImplementation(async () => null);

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false })),
        /Converted MP4 has invalid duration or no video stream for playlist duration 30s/
      );
    });

    it('should throw when archived VOD playlist has no segments', async () => {
      const emptyPlaylist = {
        variantM3u8String: '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-ENDLIST',
        baseURL: 'https://example.com/segments',
      };

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => emptyPlaylist);

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false })),
        /No segments found in HLS playlist/
      );
    });

    it('should close Impit session in finally block on error', async () => {
      mockDownloadSegmentsParallel.mock.mockImplementation(async () => {
        throw new Error('Download failed');
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, platformUserId: 'user-1', isLive: false })),
        /Download failed/
      );

      assert.strictEqual(sessionCloseCalled, true);
    });

    it('should not create Impit session for Twitch platform', async () => {
      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false }));

      assert.strictEqual(mockCreateSession.mock.callCount(), 0);
    });

    it('should create Impit session for Kick platform', async () => {
      await downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, platformUserId: 'user-1', isLive: false }));

      assert.strictEqual(mockCreateSession.mock.callCount(), 1);
    });
  });

  describe('live polling path', () => {
    it('should poll until stream end detected (5 consecutive no-change polls)', async () => {
      let pollCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const segments = pollCount <= 2 ? ['seg001.ts', 'seg002.ts'] : ['seg001.ts', 'seg002.ts', 'seg003.ts'];
        const playlistLines = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:10'];
        for (const seg of segments) {
          playlistLines.push(`#EXTINF:10.0,`);
          playlistLines.push(seg);
        }
        return {
          variantM3u8String: playlistLines.join('\n'),
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.ok(pollCount > 5, `Expected at least 5 polls, got ${pollCount}`);
      assert.ok(mockSleep.mock.callCount() >= 5);
    });

    it('should call onProgress callback during live polling', async () => {
      let progressCalls = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        return {
          // Use seg999.ts so it's not in the mockFsReaddir response and gets treated as "new"
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg999.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      mockDownloadSegmentsParallel.mock.mockImplementation(
        async (
          _segments: any,
          _vodDir: string,
          _baseURL: string,
          _strategy: any,
          _concurrency: number,
          _retries: number,
          _log: any,
          onBatchComplete?: any
        ) => {
          onBatchComplete?.(1, 1);
        }
      );

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.TWITCH,
          isLive: true,
          onProgress: () => {
            progressCalls++;
          },
        })
      );

      assert.ok(progressCalls > 0, 'Expected onProgress to be called during live polling');
    });

    it('should retry fMP4 init map download when the prior segment batch fails', async () => {
      let downloadCallCount = 0;
      const batchUris: string[][] = [];

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => ({
        variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:7\n#EXT-X-TARGETDURATION:10\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:10.0,\nseg-fmp4.m4s\n#EXT-X-ENDLIST`,
        baseURL: 'https://example.com/segments',
      }));

      mockDownloadSegmentsParallel.mock.mockImplementation(async (segments: Array<{ uri: string }>) => {
        downloadCallCount++;
        batchUris.push(segments.map((seg) => seg.uri));

        if (downloadCallCount === 1) {
          throw new Error('Download failed');
        }
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.strictEqual(mockDownloadSegmentsParallel.mock.callCount(), 2);
      assert.deepStrictEqual(batchUris[0], ['init.mp4', 'seg-fmp4.m4s']);
      assert.deepStrictEqual(batchUris[1], ['init.mp4', 'seg-fmp4.m4s']);
    });

    it('should write a cumulative live playlist instead of only the latest sliding window', async () => {
      let pollCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const segment = pollCount === 1 ? 'live-window-a.ts' : 'live-window-b.ts';
        const endlist = pollCount === 1 ? '' : '\n#EXT-X-ENDLIST';

        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\n${segment}${endlist}`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      const finalWrite = mockFsWriteFile.mock.calls.at(-1);
      assert.ok(finalWrite);
      const writtenPlaylist = finalWrite.arguments[1] as string;
      assert.ok(writtenPlaylist.includes('live-window-a.ts'));
      assert.ok(writtenPlaylist.includes('live-window-b.ts'));
      assert.ok(writtenPlaylist.includes('#EXT-X-ENDLIST'));
    });

    it('should raise local playlist target duration to fit cumulative segments', async () => {
      let pollCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const segment = pollCount === 1 ? 'live-window-a.ts' : 'live-window-b.ts';
        const endlist = pollCount === 1 ? '' : '\n#EXT-X-ENDLIST';

        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:1\n#EXTINF:12.0,\n${segment}${endlist}`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      const finalWrite = mockFsWriteFile.mock.calls.at(-1);
      assert.ok(finalWrite);
      const writtenPlaylist = finalWrite.arguments[1] as string;
      assert.ok(writtenPlaylist.includes('#EXT-X-TARGETDURATION:12'), writtenPlaylist);
    });

    it('should poll live playlists based on target duration instead of the fixed fallback interval', async () => {
      let pollCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const endlist = pollCount === 1 ? '' : '\n#EXT-X-ENDLIST';

        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.0,\nseg${pollCount}.ts${endlist}`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.strictEqual(mockSleep.mock.callCount(), 1);
      assert.strictEqual(mockSleep.mock.calls[0]?.arguments[0], 4_000);
    });

    it('should not shorten no-change stream end detection when target duration is small', async () => {
      let pollCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const endlist = pollCount > Hls.NO_CHANGE_THRESHOLD + 1 ? '\n#EXT-X-ENDLIST' : '';

        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg999.ts${endlist}`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.strictEqual(pollCount, Hls.NO_CHANGE_THRESHOLD + 2);
    });

    it('should keep cumulative live playlist media sequence aligned to the first recorded segment', async () => {
      let pollCount = 0;
      let readCount = 0;
      mockFsReadFile.mock.mockImplementation(async () => {
        readCount++;
        if (readCount === 1) {
          throw new Error('ENOENT: no such file or directory');
        }
        return (mockFsWriteFile.mock.calls.at(-1)?.arguments[1] as string | undefined) ?? mockPlaylistVariantM3u8;
      });

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const sequence = pollCount === 1 ? 100 : 101;
        const segment = pollCount === 1 ? 'live-window-a.ts' : 'live-window-b.ts';
        const endlist = pollCount === 1 ? '' : '\n#EXT-X-ENDLIST';

        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:${sequence}\n#EXTINF:10.0,\n${segment}${endlist}`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      const finalWrite = mockFsWriteFile.mock.calls.at(-1);
      assert.ok(finalWrite);
      const writtenPlaylist = finalWrite.arguments[1] as string;
      assert.ok(writtenPlaylist.includes('#EXT-X-MEDIA-SEQUENCE:100'), writtenPlaylist);
      assert.ok(!writtenPlaylist.includes('#EXT-X-MEDIA-SEQUENCE:101'), writtenPlaylist);
      assert.ok(writtenPlaylist.includes('live-window-a.ts'));
      assert.ok(writtenPlaylist.includes('live-window-b.ts'));
    });

    it('should not sleep for another poll after a verified endlist', async () => {
      mockFetchTwitchPlaylist.mock.mockImplementation(async () => ({
        variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg999.ts\n#EXT-X-ENDLIST`,
        baseURL: 'https://example.com/segments',
      }));

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.strictEqual(mockSleep.mock.callCount(), 0);
    });

    it('should strip nonessential timeline metadata from generated live playlists', async () => {
      mockFetchKickPlaylist.mock.mockImplementation(async () => ({
        variantM3u8String: `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:10
#EXT-X-PROGRAM-DATE-TIME:2026-06-18T22:46:28.870Z
#EXT-X-DATERANGE:ID="ad-1",CLASS="ad",START-DATE="2026-06-18T22:46:28.870Z",END-ON-NEXT=YES,DURATION=10
#EXTINF:10.0,
seg999.ts
#EXT-X-ENDLIST`,
        baseURL: 'https://example.com/segments',
      }));

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, platformUserId: 'kick-123', isLive: true }));

      const finalWrite = mockFsWriteFile.mock.calls.at(-1);
      assert.ok(finalWrite);
      const writtenPlaylist = finalWrite.arguments[1] as string;
      assert.ok(!writtenPlaylist.includes('#EXT-X-PROGRAM-DATE-TIME'), writtenPlaylist);
      assert.ok(!writtenPlaylist.includes('#EXT-X-DATERANGE'), writtenPlaylist);
      assert.ok(writtenPlaylist.includes('seg999.ts'));
      assert.ok(writtenPlaylist.includes('#EXT-X-ENDLIST'));
    });

    it('should close Impit session in finally block on live polling error', async () => {
      mockFetchKickPlaylist.mock.mockImplementation(async () => {
        throw new Error('Playlist fetch failed');
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, isLive: true })),
        /consecutive errors/
      );

      assert.strictEqual(sessionCloseCalled, true);
    });

    it('should refresh stale Kick live playback URL before trying archived VOD source', async () => {
      const staleUrl = 'https://kick.example.com/stale.m3u8';
      const freshUrl = 'https://kick.example.com/fresh.m3u8';
      let fetchCount = 0;
      let statusCount = 0;

      mockFetchKickPlaylist.mock.mockImplementation(async (_vodId: string, sourceUrl: string) => {
        fetchCount++;
        if (fetchCount === 1) {
          assert.strictEqual(sourceUrl, staleUrl);
          throw new Error('Impit request failed with status 403');
        }
        assert.strictEqual(sourceUrl, freshUrl);
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg999.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      mockGetKickStreamStatusResult.mock.mockImplementation(async () => {
        statusCount++;
        if (statusCount === 1) {
          return { status: 'live', stream: { id: 'vod-123', playback_url: freshUrl } };
        }
        return { status: 'offline' };
      });

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUsername: 'kickuser',
          sourceUrl: staleUrl,
          isLive: true,
        })
      );

      assert.strictEqual(mockGetKickStreamStatus.mock.callCount(), 0);
      assert.strictEqual(mockGetKickStreamStatusResult.mock.callCount(), 2);
      assert.strictEqual(mockGetVod.mock.callCount(), 0);
      assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), 2);
    });

    it('should retry immediately once after refreshing Kick playback URL, then back off repeated refreshes', async () => {
      let fetchCount = 0;

      mockFetchKickPlaylist.mock.mockImplementation(async () => {
        fetchCount++;
        if (fetchCount <= 2) {
          throw new Error('Impit request failed with status 404');
        }
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg999.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      mockGetKickStreamStatusResult.mock.mockImplementation(async () => ({
        ...(fetchCount <= 2
          ? {
              status: 'live' as const,
              stream: { id: 'vod-123', playback_url: `https://kick.example.com/fresh-${fetchCount}.m3u8` },
            }
          : { status: 'offline' as const }),
      }));

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUsername: 'kickuser',
          sourceUrl: 'https://kick.example.com/stale.m3u8',
          isLive: true,
        })
      );

      assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), 3);
      assert.strictEqual(mockGetRetryDelay.mock.callCount(), 1);
      assert.strictEqual(mockGetRetryDelay.mock.calls[0]?.arguments[1], Hls.KICK_PLAYLIST_ERROR_RETRY_BASE_MS);
      assert.strictEqual(mockSleep.mock.callCount(), 1);
      assert.strictEqual(logCalls.filter((c) => c.level === 'error').length, 0);
    });

    it('should finalize downloaded Kick live segments when archived VOD is not ready after stream end', async () => {
      let fetchCount = 0;

      mockFetchKickPlaylist.mock.mockImplementation(async () => {
        fetchCount++;
        if (fetchCount === 1) {
          return {
            variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg999.ts`,
            baseURL: 'https://example.com/segments',
          };
        }
        throw new Error('Impit request failed with status 404');
      });

      mockGetKickStreamStatusResult.mock.mockImplementation(async () => ({ status: 'offline' }));
      mockGetVod.mock.mockImplementation(async () => {
        throw new Error('VOD not found: vod-123 (kick api)');
      });

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUsername: 'kickuser',
          isLive: true,
        })
      );

      assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), 2);
      assert.strictEqual(mockGetVod.mock.callCount(), 1);
      assert.strictEqual(mockConvertHlsToMp4.mock.callCount(), 1);
      const finalWrite = mockFsWriteFile.mock.calls.at(-1);
      assert.ok(finalWrite);
      assert.ok((finalWrite.arguments[1] as string).includes('#EXT-X-ENDLIST'));
      assert.strictEqual(logCalls.filter((c) => c.level === 'error').length, 0);
    });

    it('should ignore Kick endlist while the same stream is still live', async () => {
      const staleUrl = 'https://kick.example.com/stale.m3u8';
      const freshUrl = 'https://kick.example.com/fresh.m3u8';
      let fetchCount = 0;
      let statusCount = 0;

      mockFetchKickPlaylist.mock.mockImplementation(async (_vodId: string, sourceUrl: string) => {
        fetchCount++;
        if (fetchCount === 1) {
          assert.strictEqual(sourceUrl, staleUrl);
          return {
            variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg999.ts\n#EXT-X-ENDLIST`,
            baseURL: 'https://example.com/segments',
          };
        }
        assert.strictEqual(sourceUrl, freshUrl);
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg1000.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      mockGetKickStreamStatusResult.mock.mockImplementation(async () => {
        statusCount++;
        if (statusCount === 1) {
          return { status: 'live', stream: { id: 'vod-123', playback_url: freshUrl } };
        }
        return { status: 'offline' };
      });

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUsername: 'kickuser',
          sourceUrl: staleUrl,
          isLive: true,
        })
      );

      assert.strictEqual(mockGetKickStreamStatusResult.mock.callCount(), 2);
      assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), 2);
    });

    it('should keep polling when Kick end status cannot be verified', async () => {
      let fetchCount = 0;
      let statusCount = 0;

      mockFetchKickPlaylist.mock.mockImplementation(async () => {
        fetchCount++;
        const seg = fetchCount === 1 ? 'seg999.ts' : 'seg1000.ts';
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\n${seg}\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      mockGetKickStreamStatusResult.mock.mockImplementation(async () => {
        statusCount++;
        if (statusCount === 1) {
          return { status: 'unknown', error: 'FlareSolverr timeout' };
        }
        return { status: 'offline' };
      });

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUsername: 'kickuser',
          isLive: true,
        })
      );

      assert.strictEqual(mockGetKickStreamStatusResult.mock.callCount(), 2);
      assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), 2);
    });

    it('should eventually finalize repeated Kick end signals when status remains unknown', async () => {
      mockFetchKickPlaylist.mock.mockImplementation(async () => ({
        variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg999.ts\n#EXT-X-ENDLIST`,
        baseURL: 'https://example.com/segments',
      }));

      mockGetKickStreamStatusResult.mock.mockImplementation(async () => ({
        status: 'unknown' as const,
        error: 'FlareSolverr timeout',
      }));

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUsername: 'kickuser',
          isLive: true,
        })
      );

      assert.strictEqual(mockGetKickStreamStatusResult.mock.callCount(), Hls.KICK_UNKNOWN_END_SIGNAL_THRESHOLD + 1);
      assert.strictEqual(mockFetchKickPlaylist.mock.callCount(), Hls.KICK_UNKNOWN_END_SIGNAL_THRESHOLD + 1);
    });

    it('should call Kick-specific functions during live polling', async () => {
      let pollCount = 0;
      const downloadedSet = new Set<string>();

      mockFetchKickPlaylist.mock.mockImplementation(async () => {
        pollCount++;
        const seg = pollCount <= 3 ? `live${String(pollCount).padStart(3, '0')}.ts` : 'live003.ts';
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\n${seg}`,
          baseURL: 'https://example.com/segments',
        };
      });

      mockFsReaddir.mock.mockImplementation(async () => Array.from(downloadedSet));

      mockDownloadSegmentsParallel.mock.mockImplementation(async (segments: any) => {
        for (const seg of segments) {
          downloadedSet.add(seg.uri);
        }
      });

      await downloadHlsStream(
        buildOptions({
          platform: PLATFORMS.KICK,
          platformUserId: 'kick-123',
          isLive: true,
          ctx: buildContext({ kick: { enabled: true, username: 'kickuser', id: 'kick-123' } }),
        })
      );

      mockFsReaddir.mock.mockImplementation(async (_path: string) => [
        'seg001.ts',
        'seg002.ts',
        'seg003.ts',
        'vod.mp4',
      ]);

      assert.ok(mockUpdateChapterDuringDownload.mock.callCount() >= 5);
      assert.ok(mockUpdateVodDurationDuringDownload.mock.callCount() >= 5);
    });

    it('should not call Kick-specific functions for Twitch platform', async () => {
      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      assert.strictEqual(mockUpdateChapterDuringDownload.mock.callCount(), 0);
    });

    it('should use fetch strategy for Twitch and impit strategy for Kick', async () => {
      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: false }));

      const strategyCall = mockResolveDownloadStrategy.mock.calls[0];
      assert.ok(strategyCall);
      assert.strictEqual(strategyCall.arguments[0], PLATFORMS.TWITCH);
    });

    it('should localize absolute live playlist segment URLs before conversion', async () => {
      const playlist = `#EXTM3U
#EXT-X-VERSION:7
#EXT-X-TARGETDURATION:10
#EXT-X-MAP:URI="https://cdn.example.com/live/init.mp4?token=abc"
#EXTINF:10.0,
https://cdn.example.com/live/seg999.ts?token=abc
#EXT-X-ENDLIST`;

      mockFetchKickPlaylist.mock.mockImplementation(async () => ({
        variantM3u8String: playlist,
        baseURL: 'https://cdn.example.com/live',
      }));

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.KICK, platformUserId: 'kick-123', isLive: true }));

      const writeCall = mockFsWriteFile.mock.calls[0];
      assert.ok(writeCall);
      const writtenPlaylist = writeCall.arguments[1] as string;
      assert.ok(writtenPlaylist.includes('init.mp4'));
      assert.ok(writtenPlaylist.includes('seg999.ts'));
      assert.ok(!writtenPlaylist.includes('https://cdn.example.com'));

      const downloadCall = mockDownloadSegmentsParallel.mock.calls[0];
      assert.ok(downloadCall);
      const segments = downloadCall.arguments[0] as Array<{ uri: string }>;
      assert.deepStrictEqual(
        segments.map((seg) => seg.uri),
        ['https://cdn.example.com/live/init.mp4?token=abc', 'https://cdn.example.com/live/seg999.ts?token=abc']
      );
    });
  });

  describe('error handling', () => {
    it('should treat DownloadAbortedError as retryable and fail after max consecutive errors', async () => {
      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        throw new DownloadAbortedError();
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true })),
        /consecutive errors/
      );
    });

    it('should throw after too many consecutive poll errors in live mode', async () => {
      let callCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        callCount++;
        if (callCount <= 13) {
          throw new Error('Transient error');
        }
        return mockPlaylistResult;
      });

      await assert.rejects(
        downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true })),
        /consecutive errors/
      );
    });

    it('should log error and continue polling after transient error in live mode', async () => {
      let callCount = 0;

      mockFetchTwitchPlaylist.mock.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          throw new Error('Transient error');
        }
        return {
          variantM3u8String: `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXTINF:10.0,\nseg001.ts\n#EXT-X-ENDLIST`,
          baseURL: 'https://example.com/segments',
        };
      });

      await downloadHlsStream(buildOptions({ platform: PLATFORMS.TWITCH, isLive: true }));

      const errorCalls = logCalls.filter((c) => c.level === 'error');
      assert.ok(errorCalls.length > 0, 'Expected error log after transient failure');
    });
  });

  describe('Discord alert integration', () => {
    it('should include discordMessageId in result when provided', async () => {
      const result = await downloadHlsStream(
        buildOptions({ platform: PLATFORMS.TWITCH, isLive: false, discordMessageId: 'alert-msg-1' })
      );

      assert.ok(result.success);
    });

    it('should call convertHlsToMp4 with onProgress when discordMessageId is provided', async () => {
      await downloadHlsStream(
        buildOptions({ platform: PLATFORMS.TWITCH, isLive: false, discordMessageId: 'alert-msg-1' })
      );

      assert.strictEqual(mockConvertHlsToMp4.mock.callCount(), 1);
    });
  });
});
