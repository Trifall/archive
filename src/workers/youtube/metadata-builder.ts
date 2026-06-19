import type { SelectableVods } from '../../db/streamer-types.js';
import type { Platform, SourceType } from '../../types/platforms.js';
import { capitalizePlatform, SOURCE_TYPES } from '../../types/platforms.js';
import dayjs from '../../utils/dayjs.js';

function sanitizeYoutubeText(text: string): string {
  return text.replace(/[<>]/g, '');
}

function getPublicReplayBaseUrl(domainName: string): string | null {
  const normalized = domainName.trim();
  if (normalized === '') return null;

  try {
    const url = new URL(normalized.includes('://') ? normalized : `https://${normalized}`);
    const host = url.hostname.toLowerCase();

    if (host === 'localhost' || host.endsWith('.localhost')) return null;
    if (host === '127.0.0.1' || host === '0.0.0.0' || host === '::1') return null;
    if (!host.includes('.')) return null;

    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export interface YoutubeMetadataOptions {
  channelName: string;
  platform: Platform;
  domainName: string;
  timezone: string;
  youtubeDescription?: string | undefined;
  part?: number | undefined;
  type?: SourceType;
  gameName?: string | undefined;
  epNumber?: number | undefined;
  vodRecord: Pick<SelectableVods, 'id' | 'title' | 'created_at'>;
}

export interface YoutubeMetadata {
  title: string;
  description: string;
}

export function buildYoutubeMetadata(options: YoutubeMetadataOptions): YoutubeMetadata {
  const { channelName, platform, vodRecord, domainName, timezone, youtubeDescription, part, type, gameName, epNumber } =
    options;

  const dateFormatted = dayjs(vodRecord.created_at).tz(timezone).format('MMMM DD YYYY').toUpperCase();
  const isGameUpload = gameName != null && gameName !== '';

  let title: string;
  const replayPath = isGameUpload ? `/games/${vodRecord.id}` : `/youtube/${vodRecord.id}`;

  if (isGameUpload) {
    title = `${channelName} plays ${gameName} ${epNumber != null ? `EP ${epNumber}` : ''} - ${dateFormatted}`;
  } else {
    const platformName = capitalizePlatform(platform);
    const baseTitle = `${channelName} ${platformName} ${type === SOURCE_TYPES.LIVE ? 'LIVE' : ''} VOD - ${dateFormatted}`;
    title = part != null && part > 0 ? `${baseTitle} PART ${part}` : baseTitle;
  }

  const sanitizedTitle = vodRecord.title != null && vodRecord.title !== '' ? sanitizeYoutubeText(vodRecord.title) : '';
  const sanitizedDesc =
    youtubeDescription != null && youtubeDescription !== '' ? sanitizeYoutubeText(youtubeDescription) : '';
  const replayBaseUrl = getPublicReplayBaseUrl(domainName);
  const descriptionLines = [
    ...(replayBaseUrl != null ? [`Chat Replay: ${replayBaseUrl}${replayPath}`] : []),
    `Stream Title: ${sanitizedTitle}`,
    sanitizedDesc,
  ];
  const description = descriptionLines.join('\n');

  return { title, description };
}
