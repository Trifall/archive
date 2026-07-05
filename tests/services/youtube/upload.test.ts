import { strict as assert } from 'node:assert';
import { describe, it, mock } from 'node:test';

const rawUploadError = {
  message: 'YouTube API upload failed',
  response: {
    headers: { authorization: 'Bearer secret-token' },
  },
};

const mockCreateYoutubeClient: any = mock.fn(async () => {
  throw rawUploadError;
});

mock.module('../../../src/services/youtube/client.js', {
  namedExports: {
    createYoutubeClient: mockCreateYoutubeClient,
  },
});

mock.module('../../../src/utils/auto-tenant-logger.js', {
  namedExports: {
    createAutoLogger: () => ({
      info: mock.fn(),
      debug: mock.fn(),
      warn: mock.fn(),
      error: mock.fn(),
    }),
  },
});

const { uploadVideo } = await import('../../../src/services/youtube/upload.js');

describe('uploadVideo', () => {
  it('should rethrow a sanitized Error instead of the raw upload error object', async () => {
    const progressEvents: unknown[] = [];

    await assert.rejects(
      uploadVideo(
        'test-tenant',
        'Test Tenant',
        '/tmp/test-video.mp4',
        'Test Upload',
        'Test description',
        'unlisted',
        (event) => {
          progressEvents.push(event);
        }
      ),
      (error) => {
        assert.ok(error instanceof Error);
        assert.notStrictEqual(error, rawUploadError);
        assert.strictEqual(error.message, rawUploadError.message);
        assert.strictEqual('response' in error, false);
        return true;
      }
    );

    const errorEvent = progressEvents.find(
      (event): event is { milestone: string; errorDetails: Error } =>
        typeof event === 'object' && event !== null && (event as { milestone?: string }).milestone === 'error'
    );

    assert.ok(errorEvent);
    assert.ok(errorEvent.errorDetails instanceof Error);
    assert.notStrictEqual(errorEvent.errorDetails, rawUploadError);
    assert.strictEqual(errorEvent.errorDetails.message, rawUploadError.message);
  });
});
