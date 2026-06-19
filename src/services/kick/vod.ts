import HLS from 'hls-parser';
import { Kick } from '../../constants.js';
import { VodNotFoundError } from '../../utils/domain-errors.js';
import { extractErrorDetails } from '../../utils/error.js';
import { fetchUrl } from '../../utils/flaresolverr-client.js';
import { createSession } from '../../utils/impit-wrapper.js';
import { childLogger } from '../../utils/logger.js';

const log = childLogger({ module: 'kick-vod' });

export interface KickVod {
  id: number | string;
  slug: string | null;
  channel_id: number;
  created_at: string;
  session_title: string | null;
  is_live: boolean;
  risk_level_id: number | null;
  start_time: string | null;
  source: string | null;
  twitch_channel: string | null;
  duration: number;
  language: string | null;
  is_mature: boolean;
  viewer_count: number | null;
  tags: string[] | null;
  thumbnail: {
    src: string | null;
    srcset: string | null;
  } | null;
  views: number | null;
  video: {
    id: number;
    live_stream_id: number;
    slug: string | null;
    thumb: string | null;
    s3: string | null;
    trading_platform_id: number | null;
    created_at: string;
    updated_at: string;
    uuid: string;
    views: number;
    deleted_at: string | null;
    is_pruned: boolean;
    is_private: boolean;
    status: string;
  } | null;
  categories: Array<{
    id: number;
    category_id: number;
    name: string;
    slug: string;
    tags: string[];
    description: string | null;
    deleted_at: string | null;
    is_mature: boolean;
    is_promoted: boolean;
    viewers: number;
    is_fallback: boolean;
    banner: {
      responsive: string | null;
      url: string | null;
    } | null;
  }> | null;
}

interface KickVideoByUuidResponse {
  id: number;
  live_stream_id: number;
  slug: string | null;
  thumb: string | null;
  s3: string | null;
  trading_platform_id: number | null;
  created_at: string;
  updated_at: string;
  uuid: string;
  views: number;
  deleted_at: string | null;
  is_pruned: boolean;
  is_private: boolean;
  status: string;
  source: string | null;
  livestream: Omit<KickVod, 'id' | 'source' | 'video' | 'thumbnail'> & {
    id: number;
    source: string | null;
    thumbnail: string | null;
    vod_id?: string | null;
  };
}

const KICK_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function normalizeVideoByUuid(data: KickVideoByUuidResponse): KickVod {
  return {
    ...data.livestream,
    id: data.uuid,
    source: data.source,
    thumbnail: data.livestream.thumbnail != null ? { src: data.livestream.thumbnail, srcset: null } : null,
    video: {
      id: data.id,
      live_stream_id: data.live_stream_id,
      slug: data.slug,
      thumb: data.thumb,
      s3: data.s3,
      trading_platform_id: data.trading_platform_id,
      created_at: data.created_at,
      updated_at: data.updated_at,
      uuid: data.uuid,
      views: data.views,
      deleted_at: data.deleted_at,
      is_pruned: data.is_pruned,
      is_private: data.is_private,
      status: data.status,
    },
  };
}

function getKickParsedM3u8(m3u8: string, sourceUrl: string): string | null {
  try {
    const parsed = HLS.parse(m3u8);

    if (!('variants' in parsed) || parsed.variants.length === 0) {
      return null;
    }

    const bestVariant = parsed.variants[0];
    if (bestVariant == null) return null;

    if (bestVariant.uri == null || bestVariant.uri === '') {
      return null;
    }

    return new URL(bestVariant.uri, sourceUrl.substring(0, sourceUrl.lastIndexOf('/') + 1)).toString();
  } catch (error) {
    const details = extractErrorDetails(error);
    log.debug({ details }, 'Failed to parse HLS master playlist');
    return null;
  }
}

export async function getVod(channelName: string, vodId: string): Promise<KickVod> {
  if (KICK_UUID_PATTERN.test(vodId)) {
    const byUuid = await fetchUrl<KickVideoByUuidResponse>(`${Kick.API_BASE}/api/v1/video/${vodId}`);

    if (byUuid.success && byUuid.data?.uuid === vodId) {
      return normalizeVideoByUuid(byUuid.data);
    }
  }

  const result = await fetchUrl<KickVod[]>(`${Kick.API_BASE}/api/v2/channels/${channelName}/videos`);

  if (!result.success) {
    throw new Error('Failed to load Kick videos API after retries');
  }

  const dataArray = result.data;

  if (!Array.isArray(dataArray)) {
    throw new VodNotFoundError(vodId, 'kick api response');
  }

  const video = dataArray.find((v): v is KickVod => {
    if (typeof v !== 'object') return false;
    return String(v.id) === vodId || String(v.video?.live_stream_id) === vodId || v.video?.uuid === vodId;
  });

  if (video == null) {
    throw new VodNotFoundError(vodId, 'kick api');
  }

  return video;
}

export async function getKickParsedM3u8ForFfmpeg(sourceUrl: string): Promise<string | null> {
  const session = createSession();

  try {
    const m3u8Content = await session.fetchText(sourceUrl);

    if (m3u8Content == null || m3u8Content === '') {
      throw new Error('Empty HLS playlist response from Kick');
    }

    const m3u8Url = getKickParsedM3u8(m3u8Content, sourceUrl);

    return m3u8Url ?? sourceUrl;
  } finally {
    session.close();
  }
}
