import { strict as assert } from 'node:assert';
import { beforeEach, describe, it, mock } from 'node:test';

const mockFetchText: any = mock.fn(async () => '');
const mockClose: any = mock.fn(() => {});

mock.module('../../../src/utils/impit-wrapper.js', {
  namedExports: {
    createSession: () => ({
      fetchText: mockFetchText,
      close: mockClose,
    }),
  },
});

const { getKickParsedM3u8ForFfmpeg } = await import('../../../src/services/kick/vod.js');

describe('getKickParsedM3u8ForFfmpeg', () => {
  beforeEach(() => {
    mockFetchText.mock.resetCalls();
    mockClose.mock.resetCalls();
  });

  it('detects master playlists by content when source URL does not include master.m3u8', async () => {
    mockFetchText.mock.mockImplementation(
      async () => `#EXTM3U
#EXT-X-STREAM-INF:BANDWIDTH=1000,RESOLUTION=1280x720
720p/playlist.m3u8`
    );

    const result = await getKickParsedM3u8ForFfmpeg('https://playback.example.com/channel.m3u8?token=abc');

    assert.strictEqual(result, 'https://playback.example.com/720p/playlist.m3u8');
    assert.strictEqual(mockFetchText.mock.callCount(), 1);
    assert.strictEqual(mockClose.mock.callCount(), 1);
  });

  it('returns the original source URL for media playlists', async () => {
    mockFetchText.mock.mockImplementation(
      async () => `#EXTM3U
#EXT-X-TARGETDURATION:2
#EXTINF:2,
segment-1.ts`
    );

    const result = await getKickParsedM3u8ForFfmpeg('https://playback.example.com/playlist.m3u8?token=abc');

    assert.strictEqual(result, 'https://playback.example.com/playlist.m3u8?token=abc');
    assert.strictEqual(mockClose.mock.callCount(), 1);
  });
});
