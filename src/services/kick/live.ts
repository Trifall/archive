import { Kick } from '../../constants.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { getLogger } from '../../utils/logger.js';
import type { KickVod } from './vod.js';

export interface KickCategoryRaw {
  id: number;
  name?: string;
  slug?: string;
  tags?: string[];
  parent_category?: { id: number; slug: string };
}

interface KickThumbnailRaw {
  src?: string;
  srcset?: string;
}

export interface KickLiveStreamRaw {
  id: number | string;
  slug?: string;
  session_title?: string;
  created_at: string;
  language?: string;
  is_mature?: boolean;
  viewers?: number;
  category?: KickCategoryRaw | null;
  playback_url?: string;
  thumbnail?: KickThumbnailRaw | null;
  start_time?: string | null;
}

interface KickLiveApiResponse {
  data?: KickLiveStreamRaw | null;
  error?: string;
}

export type KickStreamStatusResult =
  | { status: 'live'; stream: KickLiveStreamRaw }
  | { status: 'offline' }
  | { status: 'unknown'; error: string };

export interface KickBannerImage {
  src?: string;
}

export interface KickCategoryInfo {
  id: number;
  name?: string;
  slug?: string;
  banner?: KickBannerImage | null;
}

export async function getKickStreamStatus(username: string): Promise<KickLiveStreamRaw | null> {
  const result = await getKickStreamStatusResult(username);
  return result.status === 'live' ? result.stream : null;
}

export async function getKickStreamStatusResult(username: string): Promise<KickStreamStatusResult> {
  try {
    const apiUrl = `https://kick.com/api/v2/channels/${username}/livestream`;

    getLogger().debug({ username, apiUrl }, 'Fetching Kick livestream data');

    const result = await fetchUrl<KickLiveApiResponse>(apiUrl, {
      timeoutMs: Kick.LIVE_API_TIMEOUT_MS,
      maxRetries: 2,
    });

    if (!result.success) {
      getLogger().warn({ username, code: result.code, error: result.error }, 'Failed to reach Kick API endpoint');
      return { status: 'unknown', error: result.error };
    }

    const response = result.data;

    if (response == null) {
      getLogger().debug({ username }, 'Kick channel is offline (no livestream data)');
      return { status: 'offline' };
    }

    if ('error' in response && typeof response.error === 'string') {
      getLogger().warn({ username, error: response.error }, 'Kick API request blocked or errored');
      return { status: 'unknown', error: response.error };
    }

    const data = response.data;

    if (!data || typeof data !== 'object') {
      getLogger().debug({ username }, 'Kick channel is offline (no livestream data object)');
      return { status: 'offline' };
    }

    if (typeof data.id !== 'number' && typeof data.id !== 'string') {
      getLogger().debug(
        { username, availableKeys: Object.keys(data), idField: data.id },
        `Channel ${username} is offline (no livestream id in data)`
      );
      return { status: 'offline' };
    }

    getLogger().debug({ username, streamId: data.id, sessionTitle: data.session_title }, 'Kick live stream detected');

    return { status: 'live', stream: data };
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error({ username, ...details }, 'Failed to get Kick stream status');
    return { status: 'unknown', error: details.message };
  }
}

export async function getLatestKickVodObject(username: string, expectedStreamId: string): Promise<KickVod | null> {
  try {
    const videosUrl = `https://kick.com/api/v2/channels/${username}/videos`;

    getLogger().debug({ username, videosUrl }, 'Fetching Kick video data');

    const result = await fetchUrl<unknown[]>(videosUrl, {
      timeoutMs: Kick.LIVE_API_TIMEOUT_MS,
      maxRetries: 2,
    });

    if (!result.success) {
      getLogger().warn(
        { username, code: result.code, error: result.error },
        'Failed to reach Kick videos API endpoint'
      );
      return null;
    }

    const dataArray = result.data as unknown as KickVod[];

    if (dataArray == null || !Array.isArray(dataArray)) {
      getLogger().debug({ username }, 'Kick has no video data');
      return null;
    }

    const vodObject = dataArray.find((v: KickVod) => {
      if (v == null || typeof v !== 'object') return false;
      return String(v.id) === expectedStreamId || String(v.video?.live_stream_id) === expectedStreamId;
    });

    if (vodObject != null) {
      getLogger().debug({ username, expectedStreamId, title: vodObject.session_title }, 'Kick video object ready');

      return vodObject;
    }

    const liveStream = await getKickStreamStatus(username);

    if (liveStream == null || String(liveStream.id) !== expectedStreamId) {
      getLogger().debug({ username, expectedStreamId }, 'Kick video object not found yet');
      return null;
    }

    if (liveStream.playback_url == null || liveStream.playback_url === '') {
      getLogger().debug({ username, expectedStreamId }, 'Kick live stream has no playback URL yet');
      return null;
    }

    getLogger().debug(
      { username, expectedStreamId, title: liveStream.session_title },
      'Using Kick live stream as VOD source'
    );

    return {
      id: liveStream.id,
      slug: liveStream.slug ?? null,
      channel_id: 0,
      created_at: liveStream.created_at,
      session_title: liveStream.session_title ?? null,
      is_live: true,
      risk_level_id: null,
      start_time: liveStream.start_time ?? null,
      source: liveStream.playback_url,
      twitch_channel: null,
      duration: 0,
      language: liveStream.language ?? null,
      is_mature: liveStream.is_mature ?? false,
      viewer_count: liveStream.viewers ?? null,
      tags: null,
      thumbnail:
        liveStream.thumbnail?.src != null
          ? { src: liveStream.thumbnail.src, srcset: liveStream.thumbnail.srcset ?? null }
          : null,
      views: null,
      video: {
        id: Number(liveStream.id),
        live_stream_id: Number(liveStream.id),
        slug: liveStream.slug ?? null,
        thumb: liveStream.thumbnail?.src ?? null,
        s3: null,
        trading_platform_id: null,
        created_at: liveStream.created_at,
        updated_at: liveStream.created_at,
        uuid: String(liveStream.id),
        views: 0,
        deleted_at: null,
        is_pruned: false,
        is_private: false,
        status: 'live',
      },
      categories: liveStream.category
        ? [
            {
              id: liveStream.category.id,
              category_id: liveStream.category.parent_category?.id ?? liveStream.category.id,
              name: liveStream.category.name ?? liveStream.category.slug ?? '',
              slug: liveStream.category.slug ?? '',
              tags: liveStream.category.tags ?? [],
              description: null,
              deleted_at: null,
              is_mature: false,
              is_promoted: false,
              viewers: 0,
              is_fallback: false,
              banner: null,
            },
          ]
        : null,
    };
  } catch (error) {
    const details = extractErrorDetails(error);
    getLogger().error({ username, ...details }, 'Failed to get Kick video object');
    throw error;
  }
}
