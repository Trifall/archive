import { access, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import HLS from 'hls-parser';
import { Hls } from '../../constants.js';
import { getKickStreamStatusResult, getVod, updateChapterDuringDownload } from '../../services/kick/index.js';
import { TenantContext } from '../../types/context.js';
import { PLATFORMS, type Platform } from '../../types/platforms.js';
import { createAutoLogger } from '../../utils/auto-tenant-logger.js';
import { sleep, getRetryDelay } from '../../utils/delay.js';
import { extractErrorDetails } from '../../utils/error.js';
import { HttpError } from '../../utils/http-error.js';
import { createSession, type ImpitSession } from '../../utils/impit-wrapper.js';
import type { AppLogger } from '../../utils/logger.js';
import { getTmpDirPath, getTmpFilePath } from '../../utils/path.js';
import { createVodWorkerAlerts, safeUpdateAlert } from '../utils/alert-factories.js';
import { convertHlsToMp4, detectFmp4FromPlaylist, getMetadata } from '../utils/ffmpeg.js';
import { updateVodDurationDuringDownload } from './duration-updater.js';
import {
  downloadSegmentsParallel,
  fetchKickPlaylist,
  fetchTwitchPlaylist,
  getSegmentFileName,
  type FetchPlaylistResult,
  resolveDownloadStrategy,
} from './hls-utils.js';

export interface HlsDownloadOptions {
  ctx: TenantContext;
  dbId: number;
  vodId: string;
  platform: Platform;
  platformUserId: string;
  platformUsername?: string | undefined;
  startedAt?: string | undefined;
  sourceUrl?: string | undefined;
  isLive?: boolean | undefined;
  discordMessageId?: string | null | undefined;
  streamerName?: string | undefined;
  onProgress?: ((segmentsDownloaded: number, totalSegments: number) => void) | undefined;
}

export interface HlsDownloadResult {
  success: true;
  m3u8Path: string;
  outputDir: string;
  segmentCount: number;
  finalMp4Path: string;
}

interface HlsConvertOptions {
  vodId: string;
  onConversionProgress?: (percent: number) => void;
  discordMessageId?: string | null;
  onFfmpegStart?: (cmd: string) => void;
}

interface HlsSegmentFilterResult {
  newSegments: HLS.types.Segment[];
  newLastSegmentUri: string;
  newNoChangeCount: number;
}

interface RecordedPlaylistState {
  segments: HLS.types.Segment[];
  hasMediaSequence: boolean;
}

type SegmentWithMap = HLS.types.Segment & {
  map?: { uri?: string };
};

type WritableMediaPlaylist = HLS.types.MediaPlaylist & {
  segments: HLS.types.Segment[];
  endlist: boolean;
  targetDuration: number;
};

type KickPlaylistErrorAction = 'ended' | 'retry' | 'retry-immediate' | 'unhandled';
type KickLiveEndSignalAction = 'end' | 'continue' | 'unknown';
type KickEndDecision = {
  finalize: boolean;
  action: KickLiveEndSignalAction;
  unknownCount: number;
};

const MIN_DURATION_VALIDATION_SECONDS = 30;
const MIN_OUTPUT_DURATION_RATIO = 0.8;
const PLAYLIST_DIAGNOSTIC_SAMPLE_SIZE = 5;
const NONESSENTIAL_PLAYLIST_TAG_PREFIXES = ['#EXT-X-DATERANGE:', '#EXT-X-PROGRAM-DATE-TIME:'] as const;

function isHlsMediaFile(fileName: string): boolean {
  return fileName.endsWith('.ts') || fileName.endsWith('.mp4') || fileName.endsWith('.m4s');
}

function stripNonessentialPlaylistMetadata(m3u8Content: string): string {
  return m3u8Content
    .split('\n')
    .filter((line) => !NONESSENTIAL_PLAYLIST_TAG_PREFIXES.some((prefix) => line.startsWith(prefix)))
    .join('\n');
}

function getSegmentSequenceKey(segment: HLS.types.Segment): string | null {
  const sequence = segment.mediaSequenceNumber;
  if (!Number.isFinite(sequence) || sequence < 0) return null;
  return `media-sequence:${sequence}`;
}

function hasExplicitMediaSequence(m3u8Content: string): boolean {
  return /^#EXT-X-MEDIA-SEQUENCE:/m.test(m3u8Content);
}

function getSegmentDedupeKeys(segment: HLS.types.Segment, useMediaSequence = true): string[] {
  const keys = [getSegmentFileName(segment.uri)];
  const sequenceKey = useMediaSequence ? getSegmentSequenceKey(segment) : null;
  if (sequenceKey != null) keys.push(sequenceKey);
  return keys;
}

function hasAnyDedupeKey(keys: string[], downloadedSegments: Set<string>): boolean {
  return keys.some((key) => downloadedSegments.has(key));
}

function markSegmentDownloaded(
  segment: HLS.types.Segment,
  downloadedSegments: Set<string>,
  useMediaSequence = true
): void {
  for (const key of getSegmentDedupeKeys(segment, useMediaSequence)) downloadedSegments.add(key);
}

function getDownloadedMediaSegmentCount(downloadedSegments: Set<string>): number {
  return [...downloadedSegments].filter((fileName) => fileName.endsWith('.ts') || fileName.endsWith('.m4s')).length;
}

function getDownloadedHlsFileCount(downloadedSegments: Set<string>): number {
  return [...downloadedSegments].filter(isHlsMediaFile).length;
}

function getLivePollIntervalMs(parsed: HLS.types.MediaPlaylist): number {
  const segmentDurations = (parsed.segments ?? [])
    .map((segment) => segment.duration)
    .filter((duration) => Number.isFinite(duration) && duration > 0);
  const fallbackDuration = segmentDurations.at(-1) ?? 0;
  const durationSeconds = parsed.targetDuration > 0 ? parsed.targetDuration : fallbackDuration;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return Hls.POLL_INTERVAL_MS;

  return Math.min(Hls.POLL_INTERVAL_MS, Math.max(Hls.MIN_LIVE_POLL_INTERVAL_MS, Math.ceil(durationSeconds * 1_000)));
}

function isNoChangeStreamEnd(noChangePollCount: number, pollIntervalMs: number): boolean {
  return noChangePollCount * pollIntervalMs >= Hls.NO_CHANGE_THRESHOLD * Hls.POLL_INTERVAL_MS;
}

interface PlaylistDiagnostics {
  playlistSegmentCount: number;
  playlistDuration: number;
  playlistEndlist: boolean;
  uniqueSegmentFileCount: number;
  duplicateSegmentFileCount: number;
  missingSegmentFileCount: number;
  missingSegmentFilesSample: string[];
  zeroByteSegmentFileCount: number;
  totalSegmentBytes: number;
  minSegmentBytes: number | null;
  maxSegmentBytes: number | null;
  firstSegments: Array<{ fileName: string; duration: number; size: number | null }>;
  lastSegments: Array<{ fileName: string; duration: number; size: number | null }>;
}

export async function downloadHlsStream(options: HlsDownloadOptions): Promise<HlsDownloadResult> {
  const { ctx, dbId, vodId, platform, platformUsername, startedAt, sourceUrl, isLive = false, onProgress } = options;
  const { tenantId } = ctx;
  const log = createAutoLogger(tenantId);

  const vodDir = getTmpDirPath({ tenantId, vodId });
  const finalMp4Path = getTmpFilePath({ tenantId, vodId });
  await mkdir(vodDir, { recursive: true });

  const m3u8Path = join(vodDir, `${vodId}.m3u8`);

  const impitSession = platform === PLATFORMS.KICK ? createSession() : null;
  if (impitSession) log.info({ vodId }, 'Impit session created');

  try {
    if (isLive) {
      await runLivePollingLoop({
        ctx,
        vodId,
        platform,
        dbId,
        sourceUrl,
        platformUsername,
        startedAt,
        vodDir,
        m3u8Path,
        impitSession,
        log,
        concurrency: Hls.SEGMENT_CONCURRENCY,
        onProgress,
      });
    } else {
      await downloadArchivedVod({
        ctx,
        vodId,
        platform,
        sourceUrl,
        vodDir,
        m3u8Path,
        impitSession,
        log,
        onProgress,
      });
    }

    let hlsFfmpegCmd: string | undefined;
    const result = await convertAndCleanup(
      m3u8Path,
      finalMp4Path,
      vodDir,
      {
        vodId,
        onConversionProgress: (percent) => {
          if (options.discordMessageId != null) {
            const alertData = createVodWorkerAlerts().converting(vodId, percent);
            if (hlsFfmpegCmd != null) {
              alertData.fields = [
                ...(alertData.fields ?? []),
                { name: 'FFmpeg', value: `\`${hlsFfmpegCmd.substring(0, 500)}\``, inline: false },
              ];
            }
            safeUpdateAlert(options.discordMessageId, alertData, log, vodId);
          }
        },
        onFfmpegStart: (cmd) => {
          hlsFfmpegCmd = cmd;
        },
        discordMessageId: options.discordMessageId ?? null,
      },
      log
    );

    log.info({ vodId, platform, segmentCount: result.segmentCount }, 'HLS download and conversion complete');

    return {
      success: true,
      m3u8Path,
      outputDir: vodDir,
      segmentCount: result.segmentCount,
      finalMp4Path: result.finalMp4Path,
    };
  } finally {
    if (impitSession) {
      impitSession.close();
      log.info({ vodId }, 'Impit session closed');
    }
  }
}

async function convertAndCleanup(
  m3u8Path: string,
  finalMp4Path: string,
  vodDir: string,
  options: HlsConvertOptions,
  log: AppLogger
): Promise<{ segmentCount: number; finalMp4Path: string }> {
  const { vodId } = options;

  let m3u8Content = await readFile(m3u8Path, 'utf8');

  let playlistModified = false;
  const lines = m3u8Content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line != null && line !== '' && !line.startsWith('#') && line.includes('-muted')) {
      const unmutedLine = line.replace('-muted', '');
      const unmutedPath = join(vodDir, unmutedLine);

      try {
        await access(unmutedPath);
        lines[i] = unmutedLine;
        playlistModified = true;
      } catch {
        // unmuted file doesn't exist; leave the -muted line intact
      }
    }
  }

  if (playlistModified) {
    m3u8Content = lines.join('\n');
    await writeFile(m3u8Path, m3u8Content, 'utf8');
    log.info({ vodId }, 'Updated m3u8 playlist to use available non-muted segments');
  }

  const isFmp4 = detectFmp4FromPlaylist(m3u8Content);
  const playlistDiagnostics = await getPlaylistDiagnostics(m3u8Content, vodDir);
  const { playlistDuration } = playlistDiagnostics;

  log.info({ vodId, isFmp4, ...playlistDiagnostics }, 'Converting HLS to MP4');
  await convertHlsToMp4(m3u8Path, finalMp4Path, {
    vodId,
    isFmp4,
    ...(options.onConversionProgress && { onProgress: options.onConversionProgress }),
    ...(options.onFfmpegStart && { onStart: options.onFfmpegStart }),
  });

  const outputDuration = (await getMetadata(finalMp4Path))?.duration ?? null;
  log.info({ vodId, playlistDuration, outputDuration, finalMp4Path }, 'Converted MP4 duration check');
  if (outputDuration == null && playlistDuration >= MIN_DURATION_VALIDATION_SECONDS) {
    throw new Error(
      `Converted MP4 has invalid duration or no video stream for playlist duration ${Math.round(playlistDuration)}s`
    );
  }

  if (
    outputDuration != null &&
    playlistDuration >= MIN_DURATION_VALIDATION_SECONDS &&
    outputDuration < playlistDuration * MIN_OUTPUT_DURATION_RATIO
  ) {
    throw new Error(
      `Converted MP4 duration ${outputDuration}s is shorter than playlist duration ${Math.round(playlistDuration)}s`
    );
  }

  const segmentCount = playlistDiagnostics.playlistSegmentCount;

  return { segmentCount, finalMp4Path };
}

export function filterNewSegments(
  segments: HLS.types.Segment[],
  downloadedSegments: Set<string>,
  lastSegmentUri: string | null,
  noChangeCount: number,
  useMediaSequence = true
): HlsSegmentFilterResult {
  const currentLastUri = segments.at(-1)?.uri ?? '';

  if (currentLastUri != null && currentLastUri !== '' && currentLastUri === lastSegmentUri) {
    noChangeCount++;
  } else {
    lastSegmentUri = currentLastUri;
    noChangeCount = 0;
  }

  const newSegments = segments.filter(
    (seg) => !hasAnyDedupeKey(getSegmentDedupeKeys(seg, useMediaSequence), downloadedSegments)
  );

  return { newSegments, newLastSegmentUri: currentLastUri, newNoChangeCount: noChangeCount };
}

function localizeSegment(segment: HLS.types.Segment): HLS.types.Segment {
  const localizedSegment = { ...segment } as SegmentWithMap;
  const mapUri = localizedSegment.map?.uri;
  if (mapUri != null && mapUri !== '') {
    localizedSegment.map = { ...localizedSegment.map, uri: getSegmentFileName(mapUri) };
  }
  localizedSegment.uri = getSegmentFileName(localizedSegment.uri);
  delete localizedSegment.programDateTime;
  delete localizedSegment.dateRange;

  return localizedSegment;
}

function localizePlaylistSegments(
  variantM3u8String: string,
  segmentsOverride?: HLS.types.Segment[],
  endlistOverride?: boolean
): string {
  const parsed = HLS.parse(normalizePlaylistTargetDuration(variantM3u8String)) as WritableMediaPlaylist;
  const segments = segmentsOverride ?? parsed.segments ?? [];
  const shouldPreserveMediaSequence = hasExplicitMediaSequence(variantM3u8String);

  parsed.segments = segments.map((segment) => localizeSegment(segment));
  const firstMediaSequence = parsed.segments[0]?.mediaSequenceNumber;
  if (
    shouldPreserveMediaSequence &&
    firstMediaSequence != null &&
    Number.isFinite(firstMediaSequence) &&
    firstMediaSequence >= 0
  ) {
    parsed.mediaSequenceBase = firstMediaSequence;
  } else {
    delete parsed.mediaSequenceBase;
  }
  parsed.dateRanges = [];
  parsed.prefetchSegments = [];
  const targetDuration = Math.max(
    parsed.targetDuration ?? 0,
    ...parsed.segments.map((segment) => Math.ceil(segment.duration ?? 0))
  );
  parsed.targetDuration = targetDuration;

  if (endlistOverride != null) {
    parsed.endlist = endlistOverride;
  }

  return normalizeTargetDurationTag(HLS.stringify(parsed), targetDuration);
}

function normalizeTargetDurationTag(m3u8Content: string, targetDuration: number): string {
  if (!Number.isFinite(targetDuration) || targetDuration <= 0) return m3u8Content;

  const targetDurationLine = `#EXT-X-TARGETDURATION:${targetDuration}`;
  if (/^#EXT-X-TARGETDURATION:\d+(?:\.\d+)?$/m.test(m3u8Content)) {
    return m3u8Content.replace(/^#EXT-X-TARGETDURATION:\d+(?:\.\d+)?$/m, targetDurationLine);
  }

  if (/^#EXT-X-VERSION:.+$/m.test(m3u8Content)) {
    return m3u8Content.replace(/^#EXT-X-VERSION:.+$/m, (line) => `${line}\n${targetDurationLine}`);
  }

  return m3u8Content.replace(/^#EXTM3U$/m, `#EXTM3U\n${targetDurationLine}`);
}

function normalizePlaylistTargetDuration(m3u8Content: string): string {
  const sanitizedContent = stripNonessentialPlaylistMetadata(m3u8Content);
  const durations = [...sanitizedContent.matchAll(/^#EXTINF:([0-9]+(?:\.[0-9]+)?)/gm)]
    .map((match) => Number(match[1]))
    .filter((duration) => Number.isFinite(duration));
  if (durations.length === 0) return sanitizedContent;

  const targetDuration = Math.max(...durations.map((duration) => Math.ceil(duration)));
  const currentTargetDuration = Number(sanitizedContent.match(/^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/m)?.[1] ?? 0);
  return normalizeTargetDurationTag(sanitizedContent, Math.max(targetDuration, currentTargetDuration));
}

async function loadRecordedSegments(m3u8Path: string, log: AppLogger, vodId: string): Promise<RecordedPlaylistState> {
  try {
    const existingPlaylist = await readFile(m3u8Path, 'utf8');
    const parsed = HLS.parse(existingPlaylist) as HLS.types.MediaPlaylist;
    return { segments: [...(parsed.segments ?? [])], hasMediaSequence: hasExplicitMediaSequence(existingPlaylist) };
  } catch (error) {
    const details = extractErrorDetails(error);
    if (!details.message.includes('ENOENT')) {
      log.warn({ vodId, error: details.message }, 'Failed to load existing live playlist; starting a new one');
    }
    return { segments: [], hasMediaSequence: false };
  }
}

function appendRecordedSegments(
  recordedSegments: HLS.types.Segment[],
  recordedSegmentFileNames: Set<string>,
  currentSegments: HLS.types.Segment[],
  downloadedSegments: Set<string>,
  useMediaSequence: boolean
): number {
  let appended = 0;

  for (const segment of currentSegments) {
    const segmentKeys = getSegmentDedupeKeys(segment, useMediaSequence);
    if (hasAnyDedupeKey(segmentKeys, recordedSegmentFileNames) || !hasAnyDedupeKey(segmentKeys, downloadedSegments)) {
      continue;
    }

    recordedSegments.push(segment);
    for (const key of segmentKeys) recordedSegmentFileNames.add(key);
    appended++;
  }

  return appended;
}

function getPlaylistDurationSeconds(segments: HLS.types.Segment[]): number {
  return segments.reduce((sum, segment) => sum + (segment.duration ?? 0), 0);
}

async function getPlaylistDiagnostics(m3u8Content: string, vodDir: string): Promise<PlaylistDiagnostics> {
  const parsed = HLS.parse(normalizePlaylistTargetDuration(m3u8Content)) as HLS.types.MediaPlaylist;
  const segments = parsed.segments ?? [];
  const segmentFileNames = segments.map((segment) => getSegmentFileName(segment.uri));
  const uniqueSegmentFiles = new Set(segmentFileNames);

  let missingSegmentFileCount = 0;
  const missingSegmentFilesSample: string[] = [];
  let zeroByteSegmentFileCount = 0;
  let totalSegmentBytes = 0;
  let minSegmentBytes: number | null = null;
  let maxSegmentBytes: number | null = null;

  const segmentSizes = new Map<string, number | null>();

  const segmentStats = await Promise.all(
    [...uniqueSegmentFiles].map(async (fileName) => {
      try {
        const fileStat = await stat(join(vodDir, fileName));
        return { fileName, size: fileStat.size };
      } catch {
        return { fileName, size: null };
      }
    })
  );

  for (const { fileName, size } of segmentStats) {
    segmentSizes.set(fileName, size);
    if (size == null) {
      missingSegmentFileCount++;
      if (missingSegmentFilesSample.length < PLAYLIST_DIAGNOSTIC_SAMPLE_SIZE) {
        missingSegmentFilesSample.push(fileName);
      }
      continue;
    }

    totalSegmentBytes += size;
    minSegmentBytes = minSegmentBytes == null ? size : Math.min(minSegmentBytes, size);
    maxSegmentBytes = maxSegmentBytes == null ? size : Math.max(maxSegmentBytes, size);
    if (size === 0) zeroByteSegmentFileCount++;
  }

  const toSegmentSample = (segment: HLS.types.Segment): { fileName: string; duration: number; size: number | null } => {
    const fileName = getSegmentFileName(segment.uri);
    return { fileName, duration: segment.duration ?? 0, size: segmentSizes.get(fileName) ?? null };
  };

  return {
    playlistSegmentCount: segments.length,
    playlistDuration: getPlaylistDurationSeconds(segments),
    playlistEndlist: parsed.endlist === true,
    uniqueSegmentFileCount: uniqueSegmentFiles.size,
    duplicateSegmentFileCount: segmentFileNames.length - uniqueSegmentFiles.size,
    missingSegmentFileCount,
    missingSegmentFilesSample,
    zeroByteSegmentFileCount,
    totalSegmentBytes,
    minSegmentBytes,
    maxSegmentBytes,
    firstSegments: segments.slice(0, PLAYLIST_DIAGNOSTIC_SAMPLE_SIZE).map(toSegmentSample),
    lastSegments: segments.slice(-PLAYLIST_DIAGNOSTIC_SAMPLE_SIZE).map(toSegmentSample),
  };
}

interface LivePollingContext {
  ctx: TenantContext;
  vodId: string;
  platform: Platform;
  dbId: number;
  sourceUrl?: string | undefined;
  platformUsername?: string | undefined;
  startedAt?: string | undefined;
  vodDir: string;
  m3u8Path: string;
  impitSession: ImpitSession | null;
  log: AppLogger;
  concurrency: number;
  onProgress?: ((segmentsDownloaded: number, totalSegments: number) => void) | undefined;
}

async function runLivePollingLoop(ctx: LivePollingContext): Promise<void> {
  const { vodId, platform, log, concurrency, onProgress } = ctx;

  let consecutiveErrors = 0;
  let noChangePollCount = 0;
  let lastSegmentUri: string | null = null;
  let kickUnknownEndSignalCount = 0;
  let wrotePlaylist = false;
  let lastVariantM3u8String: string | null = null;

  const downloadedSegments = new Set<string>(await readdir(ctx.vodDir).then((files) => files.filter(isHlsMediaFile)));
  const recordedPlaylist = await loadRecordedSegments(ctx.m3u8Path, log, vodId);
  const recordedSegments = recordedPlaylist.segments;
  for (const segment of recordedSegments) {
    if (downloadedSegments.has(getSegmentFileName(segment.uri))) {
      markSegmentDownloaded(segment, downloadedSegments, recordedPlaylist.hasMediaSequence);
    }
  }
  const recordedSegmentFileNames = new Set(
    recordedSegments.flatMap((segment) => getSegmentDedupeKeys(segment, recordedPlaylist.hasMediaSequence))
  );
  if (recordedSegments.length > 0) {
    try {
      lastVariantM3u8String = normalizePlaylistTargetDuration(await readFile(ctx.m3u8Path, 'utf8'));
      wrotePlaylist = true;
    } catch (error) {
      log.warn({ vodId, error: extractErrorDetails(error).message }, 'Failed to reload existing live playlist content');
    }
  }

  let streamEnded = false;
  while (!streamEnded) {
    try {
      const playlist = await fetchPlaylist(ctx, {
        attempts: 3,
        baseDelayMs: 2000,
        shouldRetry: (err) => {
          const status = getHttpStatusFromError(err);
          if (status != null) return status === 403 || status >= 500;
          return false;
        },
      });

      const { baseURL } = playlist;
      const variantM3u8String = normalizePlaylistTargetDuration(playlist.variantM3u8String);
      lastVariantM3u8String = variantM3u8String;
      const parsed = HLS.parse(variantM3u8String) as HLS.types.MediaPlaylist;
      const segments = parsed.segments ?? [];
      const currentHasMediaSequence = hasExplicitMediaSequence(variantM3u8String);
      const hasEndList = parsed.endlist === true;
      const pollIntervalMs = getLivePollIntervalMs(parsed);
      consecutiveErrors = 0;

      const result = filterNewSegments(
        segments,
        downloadedSegments,
        lastSegmentUri,
        noChangePollCount,
        currentHasMediaSequence
      );

      if (isNoChangeStreamEnd(result.newNoChangeCount, pollIntervalMs)) {
        const kickEndDecision = await getKickEndDecision(ctx, 'no-change threshold', kickUnknownEndSignalCount);
        kickUnknownEndSignalCount = kickEndDecision.unknownCount;

        if (!kickEndDecision.finalize) {
          if (kickEndDecision.action === 'continue') {
            noChangePollCount = 0;
          }
          await sleep(pollIntervalMs);
          continue;
        }

        await writeFile(ctx.m3u8Path, localizePlaylistSegments(variantM3u8String, recordedSegments, true));
        wrotePlaylist = true;
        log.info({ vodId }, 'Stream end detected');
        streamEnded = true;
        break;
      }

      if (noChangePollCount > 0 && result.newNoChangeCount === 0) {
        log.info({ vodId, resumedAfter: noChangePollCount }, 'New segments resumed');
      }

      lastSegmentUri = result.newLastSegmentUri;
      noChangePollCount = result.newNoChangeCount;

      if (result.newSegments.length > 0) {
        const strategy = resolveDownloadStrategy(platform, ctx.impitSession);

        const segmentsToDownload: { uri: string }[] = [];
        const mapFileNamesToMarkDownloaded = new Set<string>();
        const newSegmentsTyped = result.newSegments as SegmentWithMap[];
        for (const seg of newSegmentsTyped) {
          const mapUri = seg.map?.uri;
          const mapFileName = mapUri != null ? getSegmentFileName(mapUri) : null;
          if (
            mapUri != null &&
            mapFileName != null &&
            !downloadedSegments.has(mapFileName) &&
            !mapFileNamesToMarkDownloaded.has(mapFileName)
          ) {
            mapFileNamesToMarkDownloaded.add(mapFileName);
            segmentsToDownload.push({ uri: mapUri });
          }
          segmentsToDownload.push(seg);
        }

        await downloadSegmentsParallel(
          segmentsToDownload,
          ctx.vodDir,
          baseURL,
          strategy,
          concurrency,
          Hls.SEGMENT_RETRY_ATTEMPTS,
          log,
          (completedCount) => {
            const downloadedFileCount = getDownloadedHlsFileCount(downloadedSegments);
            onProgress?.(downloadedFileCount + completedCount, downloadedFileCount + segmentsToDownload.length);
          },
          (batchCompleted) => {
            const downloadedFileCount = getDownloadedHlsFileCount(downloadedSegments);
            onProgress?.(downloadedFileCount + batchCompleted, downloadedFileCount + segmentsToDownload.length);
          }
        );

        for (const mapFileName of mapFileNamesToMarkDownloaded) downloadedSegments.add(mapFileName);
        for (const seg of result.newSegments) markSegmentDownloaded(seg, downloadedSegments, currentHasMediaSequence);
      }

      const appendedSegments = appendRecordedSegments(
        recordedSegments,
        recordedSegmentFileNames,
        segments,
        downloadedSegments,
        currentHasMediaSequence
      );
      if (appendedSegments > 0) {
        log.debug(
          { vodId, appendedSegments, recordedSegmentCount: recordedSegments.length },
          'Appended segments to cumulative live playlist'
        );
      }

      await writeFile(ctx.m3u8Path, localizePlaylistSegments(variantM3u8String, recordedSegments, false));
      wrotePlaylist = true;

      if (hasEndList) {
        const kickEndDecision = await getKickEndDecision(ctx, 'playlist endlist', kickUnknownEndSignalCount);
        kickUnknownEndSignalCount = kickEndDecision.unknownCount;

        if (!kickEndDecision.finalize) {
          noChangePollCount = 0;
          await sleep(pollIntervalMs);
          continue;
        }

        await writeFile(ctx.m3u8Path, localizePlaylistSegments(variantM3u8String, recordedSegments, true));
        log.info({ vodId }, 'Stream endlist detected');
        streamEnded = true;
        break;
      }

      consecutiveErrors = 0;
      kickUnknownEndSignalCount = 0;

      if (platform === PLATFORMS.KICK) {
        updateChapterDuringDownload(ctx.ctx, ctx.dbId, vodId).catch((err) => {
          log.warn(extractErrorDetails(err), 'chapter update failed');
        });
      }
      updateVodDurationDuringDownload(ctx.ctx, ctx.dbId, vodId, platform, ctx.m3u8Path, variantM3u8String).catch(
        (err) => {
          log.warn(extractErrorDetails(err), 'duration update failed');
        }
      );

      await sleep(pollIntervalMs);
    } catch (error) {
      const kickAction = await handleKickPlaylistError(
        ctx,
        error,
        downloadedSegments,
        wrotePlaylist,
        consecutiveErrors
      );
      if (kickAction === 'ended') {
        if (lastVariantM3u8String != null) {
          await writeFile(ctx.m3u8Path, localizePlaylistSegments(lastVariantM3u8String, recordedSegments, true));
        }
        streamEnded = true;
        break;
      }

      if (kickAction === 'retry' || kickAction === 'retry-immediate') {
        consecutiveErrors++;

        if (consecutiveErrors > Hls.MAX_CONSECUTIVE_ERRORS) {
          throw new Error(`Live HLS polling failed after ${consecutiveErrors} consecutive errors`);
        }

        if (kickAction === 'retry' || consecutiveErrors > 1) {
          await sleep(getRetryDelay(consecutiveErrors, Hls.KICK_PLAYLIST_ERROR_RETRY_BASE_MS));
        }
        continue;
      }

      const details = extractErrorDetails(error);

      log.error({ ...details, vodId }, 'Poll cycle error');

      consecutiveErrors++;
      await sleep(getRetryDelay(consecutiveErrors));

      if (consecutiveErrors > Hls.MAX_CONSECUTIVE_ERRORS) {
        throw new Error(`Live HLS polling failed after ${consecutiveErrors} consecutive errors`);
      }
    }
  }
}

async function handleKickPlaylistError(
  ctx: LivePollingContext,
  error: unknown,
  downloadedSegments: Set<string>,
  wrotePlaylist: boolean,
  consecutiveErrors: number
): Promise<KickPlaylistErrorAction> {
  if (ctx.platform !== PLATFORMS.KICK || ctx.platformUsername == null || ctx.platformUsername === '') {
    return 'unhandled';
  }

  const status = getHttpStatusFromError(error);
  if (status !== 403 && status !== 404 && status !== 410) {
    return 'unhandled';
  }

  const shouldLog = consecutiveErrors === 0 || (consecutiveErrors + 1) % 3 === 0;

  try {
    const result = await getKickStreamStatusResult(ctx.platformUsername);

    if (result.status === 'live' && String(result.stream.id) === ctx.vodId) {
      const nextErrorCount = consecutiveErrors + 1;
      const sourceUrl = result.stream.playback_url ?? undefined;
      if (sourceUrl != null && sourceUrl !== '' && sourceUrl !== ctx.sourceUrl) {
        ctx.sourceUrl = sourceUrl;
        if (shouldLog) {
          ctx.log.info(
            { vodId: ctx.vodId, status, consecutiveErrors: nextErrorCount },
            'Refreshed Kick live playback URL after playlist error'
          );
        }

        if (shouldFinalizeStaleKickLive(ctx, downloadedSegments, wrotePlaylist, status, nextErrorCount)) {
          return 'ended';
        }

        return 'retry-immediate';
      } else if (shouldLog) {
        ctx.log.warn(
          { vodId: ctx.vodId, status, consecutiveErrors: nextErrorCount },
          'Kick live playlist unavailable; retrying'
        );
      }

      if (shouldFinalizeStaleKickLive(ctx, downloadedSegments, wrotePlaylist, status, nextErrorCount)) {
        return 'ended';
      }

      return 'retry';
    }

    if (result.status === 'unknown') {
      if (shouldLog) {
        ctx.log.warn(
          { vodId: ctx.vodId, status, error: result.error, consecutiveErrors: consecutiveErrors + 1 },
          'Unable to verify Kick stream status after playlist error; retrying'
        );
      }

      return 'retry';
    }
  } catch (statusError) {
    if (shouldLog) {
      ctx.log.warn(
        { vodId: ctx.vodId, status, error: extractErrorDetails(statusError).message },
        'Failed to verify Kick live status after playlist error; retrying'
      );
    }

    return 'retry';
  }

  if (await refreshKickArchivedVodSource(ctx, shouldLog)) {
    return 'retry-immediate';
  }

  if (wrotePlaylist && downloadedSegments.size > 0) {
    const downloadedMediaSegments = getDownloadedMediaSegmentCount(downloadedSegments);
    ctx.log.info(
      { vodId: ctx.vodId, status, segmentCount: downloadedMediaSegments, fileCount: downloadedSegments.size },
      'Kick stream ended before archived VOD source was available; finalizing downloaded HLS segments'
    );
    return 'ended';
  }

  return 'unhandled';
}

function shouldFinalizeStaleKickLive(
  ctx: LivePollingContext,
  downloadedSegments: Set<string>,
  wrotePlaylist: boolean,
  status: number | null,
  consecutiveErrors: number
): boolean {
  if (!wrotePlaylist || downloadedSegments.size === 0 || consecutiveErrors < Hls.KICK_STALE_LIVE_ERROR_THRESHOLD) {
    return false;
  }

  const downloadedMediaSegments = getDownloadedMediaSegmentCount(downloadedSegments);
  if (downloadedMediaSegments === 0) return false;

  ctx.log.warn(
    { vodId: ctx.vodId, status, consecutiveErrors, segmentCount: downloadedMediaSegments },
    'Finalizing downloaded Kick live segments after repeated playlist failures despite live status'
  );
  return true;
}

function getHttpStatusFromError(error: unknown): number | null {
  if (error instanceof HttpError) return error.statusCode;

  const structuredStatus = getStructuredHttpStatus(error, 0);
  if (structuredStatus != null) return structuredStatus;

  const details = extractErrorDetails(error);
  const match = details.message.match(/\b(?:status(?:Code)?|HTTP)\s*[:=]?\s*(\d{3})\b/i);
  if (match?.[1] == null) return null;
  return normalizeHttpStatus(Number.parseInt(match[1], 10));
}

function getStructuredHttpStatus(error: unknown, depth: number): number | null {
  if (depth > 2) return null;
  if (typeof error !== 'object' || error === null) return null;

  const record = error as Record<string, unknown>;
  return (
    normalizeHttpStatus(record.statusCode) ??
    normalizeHttpStatus(record.status) ??
    getStructuredHttpStatus(record.response, depth + 1) ??
    getStructuredHttpStatus(record.cause, depth + 1)
  );
}

function normalizeHttpStatus(status: unknown): number | null {
  const numericStatus = typeof status === 'string' && /^\d{3}$/.test(status) ? Number.parseInt(status, 10) : status;
  return typeof numericStatus === 'number' &&
    Number.isInteger(numericStatus) &&
    numericStatus >= 100 &&
    numericStatus <= 599
    ? numericStatus
    : null;
}

async function refreshKickArchivedVodSource(ctx: LivePollingContext, shouldLog: boolean): Promise<boolean> {
  if (ctx.platformUsername == null || ctx.platformUsername === '') {
    return false;
  }

  try {
    const vod = await getVod(ctx.platformUsername, ctx.vodId);
    const sourceUrl = vod.source ?? undefined;

    if (sourceUrl == null || sourceUrl === '' || sourceUrl === ctx.sourceUrl) {
      return false;
    }

    ctx.sourceUrl = sourceUrl;
    ctx.log.info({ vodId: ctx.vodId, sourceUrl }, 'Switched Kick live download to archived VOD source');
    return true;
  } catch (refreshError) {
    if (shouldLog) {
      ctx.log.warn(
        { vodId: ctx.vodId, error: extractErrorDetails(refreshError).message },
        'Failed to refresh Kick archived VOD source'
      );
    }
    return false;
  }
}

async function getKickEndDecision(
  ctx: LivePollingContext,
  reason: string,
  unknownCount: number
): Promise<KickEndDecision> {
  const action = await getKickLiveEndSignalAction(ctx, reason);

  if (action === 'end') {
    return { finalize: true, action, unknownCount: 0 };
  }

  if (action === 'continue') {
    return { finalize: false, action, unknownCount: 0 };
  }

  const nextUnknownCount = unknownCount + 1;
  if (nextUnknownCount > Hls.KICK_UNKNOWN_END_SIGNAL_THRESHOLD) {
    ctx.log.warn(
      { vodId: ctx.vodId, reason, unknownCount: nextUnknownCount },
      'Finalizing after repeated unknown Kick end signal checks'
    );
    return { finalize: true, action, unknownCount: 0 };
  }

  return { finalize: false, action, unknownCount: nextUnknownCount };
}

async function getKickLiveEndSignalAction(ctx: LivePollingContext, reason: string): Promise<KickLiveEndSignalAction> {
  if (ctx.platform !== PLATFORMS.KICK || ctx.platformUsername == null || ctx.platformUsername === '') {
    return 'end';
  }

  try {
    const result = await getKickStreamStatusResult(ctx.platformUsername);

    if (result.status === 'unknown') {
      ctx.log.warn(
        { vodId: ctx.vodId, reason, error: result.error },
        'Unable to verify Kick stream ended; continuing live polling'
      );
      return 'unknown';
    }

    if (result.status === 'offline' || String(result.stream.id) !== ctx.vodId) {
      return 'end';
    }

    const sourceUrl = result.stream.playback_url ?? undefined;
    if (sourceUrl != null && sourceUrl !== '' && sourceUrl !== ctx.sourceUrl) {
      ctx.sourceUrl = sourceUrl;
      ctx.log.info({ vodId: ctx.vodId, reason }, 'Refreshed Kick live playback URL after premature end signal');
    } else {
      ctx.log.warn({ vodId: ctx.vodId, reason }, 'Ignoring Kick HLS end signal because stream is still live');
    }

    return 'continue';
  } catch (error) {
    ctx.log.warn(
      { vodId: ctx.vodId, reason, error: extractErrorDetails(error).message },
      'Failed to verify Kick live status'
    );
    return 'unknown';
  }
}

interface ArchivedVodContext {
  ctx: TenantContext;
  vodId: string;
  platform: Platform;
  sourceUrl?: string | undefined;
  vodDir: string;
  m3u8Path: string;
  impitSession: ImpitSession | null;
  log: AppLogger;
  onProgress?: ((segmentsDownloaded: number, totalSegments: number) => void) | undefined;
}

async function downloadArchivedVod(ctx: ArchivedVodContext): Promise<void> {
  const { vodId, platform, vodDir, m3u8Path, impitSession, log, onProgress } = ctx;

  const playlist = await fetchPlaylist(ctx, { attempts: 3, baseDelayMs: 2000 });

  const { baseURL } = playlist;
  const variantM3u8String = normalizePlaylistTargetDuration(playlist.variantM3u8String);

  await writeFile(m3u8Path, localizePlaylistSegments(variantM3u8String));

  const parsed = HLS.parse(variantM3u8String) as HLS.types.MediaPlaylist;
  const rawSegments = (parsed.segments ?? []) as SegmentWithMap[];

  if (rawSegments.length === 0) {
    throw new Error('No segments found in HLS playlist');
  }

  const segmentsToDownload: { uri: string }[] = [];
  const seenUris = new Set<string>();

  for (const seg of rawSegments) {
    const mapUri = seg.map?.uri;
    if (mapUri != null && !seenUris.has(mapUri)) {
      seenUris.add(mapUri);
      segmentsToDownload.push({ uri: mapUri });
    }
    if (!seenUris.has(seg.uri)) {
      seenUris.add(seg.uri);
      segmentsToDownload.push(seg);
    }
  }

  log.debug({ vodId, count: segmentsToDownload.length }, 'Found segments to download (including init)');

  const strategy = resolveDownloadStrategy(platform, impitSession);

  await downloadSegmentsParallel(
    segmentsToDownload,
    vodDir,
    baseURL,
    strategy,
    Hls.SEGMENT_CONCURRENCY,
    Hls.SEGMENT_RETRY_ATTEMPTS,
    log,
    (completedCount) => onProgress?.(completedCount, segmentsToDownload.length),
    (completedCount, total) => onProgress?.(completedCount, total)
  );
}

export async function fetchPlaylist(
  ctx: LivePollingContext | ArchivedVodContext,
  retryOptions?: {
    attempts?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  }
): Promise<FetchPlaylistResult> {
  const tenantId = ctx.ctx.tenantId;

  if (ctx.platform === PLATFORMS.TWITCH) {
    return fetchTwitchPlaylist(ctx.vodId, ctx.log, tenantId, retryOptions);
  }
  return fetchKickPlaylist(ctx.vodId, ctx.sourceUrl, ctx.log, ctx.impitSession ?? undefined, retryOptions);
}
